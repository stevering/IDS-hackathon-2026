/**
 * MCP activities v2 — instance-based routing.
 *
 * Replaces the hardcoded MCP_SERVERS registry with DB-driven user_mcp_instances.
 * Cloud instances are called directly via HTTP + Vault token.
 * Local instances are routed through the Guardian overlay bridge via Supabase Realtime.
 *
 * Coexists with mcp.ts (v1) during the migration. Workflows will switch from
 * discoverMCPTools → discoverMCPToolsV2 once validated.
 */

import { createClient } from "@supabase/supabase-js";
import { createMCPClient } from "@ai-sdk/mcp";
import {
  BUILTIN_PRESETS,
  buildToolPrefix,
  presetSlugOf,
  type BuiltinPreset,
} from "@guardian/orchestrations";
import type { LLMToolDefinition } from "@guardian/orchestrations";
import { callBridgedMCP } from "./mcp-bridge-client.js";
import { createLogger } from "../lib/log.js";

// ---------------------------------------------------------------------------
// Supabase helper
// ---------------------------------------------------------------------------

function createServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase credentials not configured");
  return createClient(supabaseUrl, serviceKey);
}

// ---------------------------------------------------------------------------
// Types matching the DB RPC return
// ---------------------------------------------------------------------------

type DBInstance = {
  id: string;
  preset_type: string;
  category: string;
  scope: string;
  label: string;
  display_name: string | null;
  device_id: string | null;
  device_name: string | null;
  device_last_seen_at: string | null;
  config: Record<string, unknown>;
  connection_server_id: string | null;
  enabled: boolean;
};

/** Instance manifest entry — shared with the LLM system prompt builder. */
export type InstanceManifestEntry = {
  instanceId: string;
  label: string;
  presetType: string;
  category: string;
  scope: string;
  displayName: string | null;
  toolPrefix: string;
  toolCount: number;
  toolNames: string[];
  isFocus: boolean;
};

// ---------------------------------------------------------------------------
// discoverMCPToolsV2 — instance-based discovery
// ---------------------------------------------------------------------------

export async function discoverMCPToolsV2(params: {
  userId: string;
  focusDesignInstanceId?: string;
  focusCodeInstanceId?: string;
}): Promise<{
  focusTools: LLMToolDefinition[];
  instanceManifest: InstanceManifestEntry[];
}> {
  const log = createLogger("mcp-v2-discover", { u: params.userId.slice(0, 8) });
  const supabase = createServiceClient();

  // Load all enabled instances for this user
  const { data: rows, error } = await supabase.rpc("list_mcp_instances_service", {
    p_user_id: params.userId,
  });

  if (error) {
    log.error("Failed to load instances", { error: error.message });
    return { focusTools: [], instanceManifest: [] };
  }

  const instances = (rows ?? []) as DBInstance[];
  log.info(`Loaded ${instances.length} enabled instance(s)`);

  const focusIds = new Set([params.focusDesignInstanceId, params.focusCodeInstanceId].filter(Boolean));
  const focusTools: LLMToolDefinition[] = [];
  const manifest: InstanceManifestEntry[] = [];

  for (const inst of instances) {
    const prefix = buildToolPrefix(inst.preset_type, inst.label);
    const preset = BUILTIN_PRESETS[inst.preset_type];
    const isFocus = focusIds.has(inst.id);

    try {
      let tools: LLMToolDefinition[];

      if (inst.scope === "cloud") {
        tools = await discoverCloudInstance(supabase, params.userId, inst, prefix, preset, log);
      } else {
        tools = await discoverBridgedInstance(params.userId, inst, prefix, log);
      }

      manifest.push({
        instanceId: inst.id,
        label: inst.label,
        presetType: inst.preset_type,
        category: inst.category,
        scope: inst.scope,
        displayName: inst.display_name,
        toolPrefix: prefix,
        toolCount: tools.length,
        toolNames: tools.map((t) => t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name),
        isFocus,
      });

      if (isFocus) {
        focusTools.push(...tools);
      }

      log.info(`${inst.label}: ${tools.length} tools ${isFocus ? "(FOCUS)" : ""}`);
    } catch (err) {
      log.error(`Failed to discover ${inst.label}`, { error: String(err) });
      manifest.push({
        instanceId: inst.id,
        label: inst.label,
        presetType: inst.preset_type,
        category: inst.category,
        scope: inst.scope,
        displayName: inst.display_name,
        toolPrefix: prefix,
        toolCount: 0,
        toolNames: [],
        isFocus,
      });
    }
  }

  log.info(`Discovery complete: ${focusTools.length} focus tools, ${manifest.length} instances`);
  return { focusTools, instanceManifest: manifest };
}

// ---------------------------------------------------------------------------
// Cloud instance discovery (direct HTTP with Vault token)
// ---------------------------------------------------------------------------

async function discoverCloudInstance(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  inst: DBInstance,
  prefix: string,
  preset: BuiltinPreset | undefined,
  log: ReturnType<typeof createLogger>,
): Promise<LLMToolDefinition[]> {
  if (!inst.connection_server_id) {
    log.warn(`${inst.label}: no connection_server_id (not connected)`);
    return [];
  }

  let accessToken: string | undefined;
  if (inst.preset_type === "guardian") {
    accessToken = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;
  } else {
    const { data: tokensJson, error } = await supabase.rpc("get_mcp_connection_service", {
      p_user_id: userId,
      p_server_id: inst.connection_server_id,
    });

    if (error || !tokensJson) {
      log.warn(`${inst.label}: no vault token for ${inst.connection_server_id}`);
      return [];
    }

    const tokens = JSON.parse(tokensJson as string);
    accessToken = tokens.access_token;
    if (!accessToken) {
      log.warn(`${inst.label}: token has no access_token`);
      return [];
    }
  }

  const url = preset?.cloud_url ?? (inst.config as { url?: string }).url;
  if (!url) {
    log.warn(`${inst.label}: no URL`);
    return [];
  }

  const headers: Record<string, string> = {};
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  if (inst.preset_type === "guardian") {
    headers["X-Guardian-User-Id"] = userId;
  }

  const client = await createMCPClient({
    transport: { type: "http", url, headers: Object.keys(headers).length > 0 ? headers : undefined },
  });
  const mcpTools = await client.tools();
  await client.close();

  return Object.entries(mcpTools).map(([name, tool]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = tool as any;
    return {
      name: `${prefix}${name}`,
      description: t.description ?? "",
      parameters: t.parameters ?? t.inputSchema?.jsonSchema ?? {},
    };
  });
}

// ---------------------------------------------------------------------------
// Bridged instance discovery (overlay via Supabase Realtime)
// ---------------------------------------------------------------------------

async function discoverBridgedInstance(
  userId: string,
  inst: DBInstance,
  prefix: string,
  log: ReturnType<typeof createLogger>,
): Promise<LLMToolDefinition[]> {
  if (!inst.device_id) {
    log.warn(`${inst.label}: no device_id`);
    return [];
  }

  const result = await callBridgedMCP({
    userId,
    deviceId: inst.device_id,
    instanceId: inst.id,
    method: "tools/list",
    timeoutMs: 10_000,
  });

  if (!result.ok) {
    log.warn(`${inst.label}: bridge error — ${result.error}`);
    return [];
  }

  const toolList = result.result as Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  return toolList.map((t) => ({
    name: `${prefix}${t.name}`,
    description: t.description ?? "",
    parameters: t.parameters ?? {},
  }));
}

// ---------------------------------------------------------------------------
// executeMCPToolV2 — instance-based execution
// ---------------------------------------------------------------------------

export async function executeMCPToolV2(params: {
  userId: string;
  instanceId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const log = createLogger("mcp-v2-exec", { u: params.userId.slice(0, 8), tool: params.toolName });
  const supabase = createServiceClient();

  // Load the specific instance
  const { data: rows } = await supabase.rpc("list_mcp_instances_service", {
    p_user_id: params.userId,
  });
  const instances = (rows ?? []) as DBInstance[];
  const inst = instances.find((i) => i.id === params.instanceId);

  if (!inst) {
    return { success: false, error: `Instance ${params.instanceId} not found or disabled` };
  }

  if (inst.scope === "local") {
    // Route through bridge
    if (!inst.device_id) {
      return { success: false, error: `Instance ${inst.label} has no device` };
    }

    const result = await callBridgedMCP({
      userId: params.userId,
      deviceId: inst.device_id,
      instanceId: inst.id,
      method: "tools/call",
      params: { name: params.toolName, arguments: params.arguments },
    });

    if (result.ok) {
      return { success: true, result: result.result };
    }
    return { success: false, error: result.error };
  }

  // Cloud: direct HTTP call
  if (!inst.connection_server_id) {
    return { success: false, error: `Instance ${inst.label} is not connected (no OAuth token)` };
  }

  const { data: tokensJson } = await supabase.rpc("get_mcp_connection_service", {
    p_user_id: params.userId,
    p_server_id: inst.connection_server_id,
  });

  if (!tokensJson) {
    return { success: false, error: `No token for ${inst.connection_server_id}` };
  }

  const tokens = JSON.parse(tokensJson as string);
  if (!tokens.access_token) {
    return { success: false, error: `Token for ${inst.label} has no access_token` };
  }

  const preset = BUILTIN_PRESETS[inst.preset_type];
  const url = preset?.cloud_url ?? (inst.config as { url?: string }).url;
  if (!url) {
    return { success: false, error: `No URL for ${inst.label}` };
  }

  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${tokens.access_token}` };
    const client = await createMCPClient({
      transport: { type: "http", url, headers },
    });
    const mcpTools = await client.tools();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = mcpTools[params.toolName] as any;
    if (!tool) {
      await client.close();
      return { success: false, error: `Tool "${params.toolName}" not found on ${inst.label}` };
    }

    const result = await tool.execute(params.arguments, { toolCallId: `mcp-${Date.now()}` });
    await client.close();

    if (result && typeof result === "object" && (result as Record<string, unknown>).isError) {
      // Extract the actual error text from the MCP CallToolResult content
      let errorText = "Tool reported an error";
      try {
        const r = result as { content?: Array<{ type: string; text?: string }> };
        if (Array.isArray(r.content)) {
          const texts = r.content.filter(c => c.type === "text" && c.text).map(c => c.text);
          if (texts.length > 0) errorText = texts.join("\n");
        }
      } catch { /* use fallback */ }
      return { success: false, result, error: errorText };
    }

    log.info(`Execution succeeded on ${inst.label}/${params.toolName}`);
    return { success: true, result };
  } catch (err) {
    log.error(`Execution failed`, { error: String(err) });
    return { success: false, error: String(err) };
  }
}
