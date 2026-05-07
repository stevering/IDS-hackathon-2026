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
import { pairFCCloudRelay } from "./mcp.js";
import {
  refreshOAuthTokenIfNeeded,
  forceRefreshOAuthToken,
  resolveRefreshConfigFromPreset,
  completeRefreshConfig,
  type StoredTokens,
} from "./oauth-refresh.js";
import { createLogger } from "../lib/log.js";

// ---------------------------------------------------------------------------
// 401 detection (library-agnostic string match on the error message)
// ---------------------------------------------------------------------------

function is401Error(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b401\b/.test(msg) || /Unauthorized/i.test(msg);
}

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
  /** Populated when discovery failed for this instance (surfaced to the UI). */
  error?: string;
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
      // Undici's `fetch failed` is a generic top-level message; the real
      // reason lives on `err.cause` (e.g. UND_ERR_SOCKET, ECONNRESET,
      // UND_ERR_HEADERS_TIMEOUT). Include it so cloud MCP failures are
      // actually diagnosable.
      const errorMsg = err instanceof Error ? err.message : String(err);
      const causeMsg =
        err instanceof Error && err.cause
          ? err.cause instanceof Error
            ? `${err.cause.name}: ${err.cause.message}`
            : String(err.cause)
          : undefined;
      log.error(`Failed to discover ${inst.label}`, {
        error: causeMsg ? `${errorMsg} (cause: ${causeMsg})` : errorMsg,
      });
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
        error: errorMsg,
      });
    }
  }

  log.info(`Discovery complete: ${focusTools.length} focus tools, ${manifest.length} instances`);
  return { focusTools, instanceManifest: manifest };
}

// ---------------------------------------------------------------------------
// Shared helper: load cloud access token (with auto-refresh via RFC 6749)
// ---------------------------------------------------------------------------

/**
 * For cloud instances, resolves the access token to use:
 *   - Guardian (special): service-role key
 *   - Other presets: reads from Vault, auto-refreshes if expiring soon
 *
 * Returns undefined if no token is available (caller should skip/fail).
 */
async function loadCloudAccessToken(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  inst: DBInstance,
  preset: BuiltinPreset | undefined,
  log: ReturnType<typeof createLogger>,
): Promise<string | undefined> {
  // Special case: Guardian MCP uses service-role key directly
  if (inst.preset_type === "guardian") {
    return process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;
  }

  if (!inst.connection_server_id) {
    log.warn(`${inst.label}: no connection_server_id (not connected)`);
    return undefined;
  }

  // Fetch tokens from Vault
  const { data: tokensJson, error } = await supabase.rpc("get_mcp_connection_service", {
    p_user_id: userId,
    p_server_id: inst.connection_server_id,
  });

  if (error || !tokensJson) {
    log.warn(`${inst.label}: no vault token for ${inst.connection_server_id}`);
    return undefined;
  }

  let currentTokens: StoredTokens;
  try {
    currentTokens = JSON.parse(tokensJson as string) as StoredTokens;
  } catch {
    log.warn(`${inst.label}: malformed tokens JSON`);
    return undefined;
  }

  // Fetch expiry from user_mcp_connections metadata (non-sensitive, no Vault)
  const { data: connRow } = await supabase
    .from("user_mcp_connections")
    .select("expires_at, scopes")
    .eq("user_id", userId)
    .eq("server_id", inst.connection_server_id)
    .maybeSingle();

  const expiresAt = connRow?.expires_at ? new Date(connRow.expires_at as string) : null;
  const scopes = (connRow?.scopes as string | null) ?? undefined;

  // Refresh if expiring soon and the preset declares a refresh endpoint.
  // Credentials come from env vars OR from the stored tokens (_guardian_client_info)
  // for DCR-based providers (Southleft, future Figma MCP).
  const partialConfig = preset ? resolveRefreshConfigFromPreset(preset) : undefined;
  const refreshConfig = completeRefreshConfig(partialConfig, currentTokens);
  const refreshResult = await refreshOAuthTokenIfNeeded({
    supabase,
    userId,
    serverId: inst.connection_server_id,
    currentTokens,
    expiresAt,
    refreshConfig,
    scopes,
  });

  if (refreshResult.refreshed) {
    log.info(`${inst.label}: token auto-refreshed`);
  }

  const accessToken = refreshResult.tokens.access_token;
  if (!accessToken) {
    log.warn(`${inst.label}: token has no access_token after refresh`);
    return undefined;
  }

  return accessToken;
}

/**
 * Force a reactive token refresh and return the new access token.
 * Used on 401 errors when the proactive refresh didn't fire (e.g. expires_at
 * is wrong). Returns undefined if refresh is impossible.
 */
async function forceRefreshCloudToken(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  inst: DBInstance,
  preset: BuiltinPreset | undefined,
  log: ReturnType<typeof createLogger>,
): Promise<string | undefined> {
  if (!inst.connection_server_id || !preset) return undefined;

  const { data: tokensJson } = await supabase.rpc("get_mcp_connection_service", {
    p_user_id: userId,
    p_server_id: inst.connection_server_id,
  });
  if (!tokensJson) return undefined;

  let currentTokens: StoredTokens;
  try {
    currentTokens = JSON.parse(tokensJson as string) as StoredTokens;
  } catch {
    return undefined;
  }

  const { data: connRow } = await supabase
    .from("user_mcp_connections")
    .select("scopes")
    .eq("user_id", userId)
    .eq("server_id", inst.connection_server_id)
    .maybeSingle();

  const partialConfig = resolveRefreshConfigFromPreset(preset);
  const refreshConfig = completeRefreshConfig(partialConfig, currentTokens);
  const newTokens = await forceRefreshOAuthToken({
    supabase,
    userId,
    serverId: inst.connection_server_id,
    currentTokens,
    refreshConfig,
    scopes: (connRow?.scopes as string | null) ?? undefined,
  });

  if (!newTokens?.access_token) {
    log.warn(`${inst.label}: force refresh failed, cannot retry`);
    return undefined;
  }

  return newTokens.access_token;
}

// ---------------------------------------------------------------------------
// Cloud instance discovery (direct HTTP with Vault token + 401 retry)
// ---------------------------------------------------------------------------

async function discoverCloudInstance(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  inst: DBInstance,
  prefix: string,
  preset: BuiltinPreset | undefined,
  log: ReturnType<typeof createLogger>,
): Promise<LLMToolDefinition[]> {
  const url = preset?.cloud_url ?? (inst.config as { url?: string }).url;
  if (!url) {
    log.warn(`${inst.label}: no URL`);
    return [];
  }

  const initialToken = await loadCloudAccessToken(supabase, userId, inst, preset, log);
  if (!initialToken) return [];

  // Attempt discovery with the current token; on 401, force a refresh and retry once.
  const tryFetch = async (accessToken: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (inst.preset_type === "guardian") {
      headers["X-Guardian-User-Id"] = userId;
    }
    const client = await createMCPClient({
      transport: { type: "http", url, headers },
    });
    try {
      return await client.tools();
    } finally {
      await client.close().catch(() => {});
    }
  };

  let mcpTools;
  try {
    mcpTools = await tryFetch(initialToken);
  } catch (err) {
    if (!is401Error(err)) throw err;
    log.warn(`${inst.label}: 401 on discovery — attempting force refresh`);
    const refreshedToken = await forceRefreshCloudToken(supabase, userId, inst, preset, log);
    if (!refreshedToken) {
      log.error(`${inst.label}: force refresh failed, cannot retry`);
      throw err;
    }
    mcpTools = await tryFetch(refreshedToken);
    log.info(`${inst.label}: discovery succeeded after reactive refresh`);
  }

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
  pluginClientId?: string;
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

  // ── Figma Console interceptor: figma_pair_plugin ───────────────────────────
  // Pairing is internal to Guardian — never expose Southleft's pairing code or
  // manual instructions to the LLM. Re-pair via pairFCCloudRelay and return a
  // neutral result.
  const isFigmaConsole = inst.preset_type === "figma_console";
  if (isFigmaConsole && params.toolName === "figma_pair_plugin") {
    log.info("Intercepting figma_pair_plugin — running Guardian auto-pair instead");
    const pair = await pairFCCloudRelay({
      userId: params.userId,
      pluginClientId: params.pluginClientId,
    });
    if (pair.success) {
      return {
        success: true,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "paired",
              note: "Auto-pairing handled by Guardian. The Figma plugin is connected via the cloud relay. Retry your previous tool call.",
            }),
          }],
          isError: false,
        },
      };
    }
    return {
      success: false,
      error: pair.error ?? "Cloud relay pairing failed. The Guardian plugin is not running in Figma. Ask the user to open Figma Desktop with the Guardian plugin, then retry.",
    };
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

  // Cloud: direct HTTP call with proactive + reactive refresh
  const preset = BUILTIN_PRESETS[inst.preset_type];
  const url = preset?.cloud_url ?? (inst.config as { url?: string }).url;
  if (!url) {
    return { success: false, error: `No URL for ${inst.label}` };
  }

  const initialToken = await loadCloudAccessToken(supabase, params.userId, inst, preset, log);
  if (!initialToken) {
    return { success: false, error: `Instance ${inst.label} is not connected (no OAuth token)` };
  }

  // Single tool call with potential 401 retry after reactive refresh.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tryExecute = async (accessToken: string): Promise<any> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    const client = await createMCPClient({
      transport: { type: "http", url, headers },
    });
    try {
      const mcpTools = await client.tools();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = mcpTools[params.toolName] as any;
      if (!tool) {
        throw new Error(`Tool "${params.toolName}" not found on ${inst.label}`);
      }
      return await tool.execute(params.arguments, { toolCallId: `mcp-${Date.now()}` });
    } finally {
      await client.close().catch(() => {});
    }
  };

  // Run the tool call (with potential 401 reactive refresh) and surface
  // success / failure as a structured outcome so we can apply Figma Console
  // recovery on top.
  const runOnce = async (): Promise<{ success: boolean; result?: unknown; error?: string }> => {
    try {
      let result;
      try {
        result = await tryExecute(initialToken);
      } catch (err) {
        if (!is401Error(err)) throw err;
        log.warn(`${inst.label}: 401 on exec — attempting force refresh`);
        const refreshedToken = await forceRefreshCloudToken(supabase, params.userId, inst, preset, log);
        if (!refreshedToken) {
          log.error(`${inst.label}: force refresh failed, cannot retry`);
          throw err;
        }
        result = await tryExecute(refreshedToken);
        log.info(`${inst.label}: execution succeeded after reactive refresh`);
      }

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
  };

  let outcome = await runOnce();

  // ── Figma Console recovery: "No plugin connected to cloud relay" ───────────
  // Auto-pair may have failed, the plugin may have reloaded, or the relay
  // may have dropped between turns. Re-pair on demand and retry once. If
  // recovery fails, rewrite the error so the LLM never sees Southleft's
  // manual pairing instructions.
  const NO_PLUGIN_RE = /no\s+plugin\s+connected\s+to\s+cloud\s+relay/i;
  const looksLikeNoPlugin = (out: typeof outcome): boolean => {
    if (out.success) return false;
    if (out.error && NO_PLUGIN_RE.test(out.error)) return true;
    if (out.result) {
      try { return NO_PLUGIN_RE.test(JSON.stringify(out.result)); } catch { return false; }
    }
    return false;
  };
  const guardianRewrite = "Guardian plugin is not running in Figma. Ask the user to open Figma Desktop and launch the Guardian plugin, then retry. (Pairing is automatic — no manual code entry needed.)";

  if (isFigmaConsole && looksLikeNoPlugin(outcome)) {
    log.warn("Figma Console returned 'no plugin connected' — re-pairing and retrying once");
    const pair = await pairFCCloudRelay({
      userId: params.userId,
      pluginClientId: params.pluginClientId,
    });
    if (pair.success) {
      outcome = await runOnce();
      if (looksLikeNoPlugin(outcome)) outcome = { ...outcome, error: guardianRewrite };
    } else {
      outcome = { ...outcome, error: guardianRewrite };
    }
  }

  return outcome;
}
