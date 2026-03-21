/**
 * MCP activities for Temporal workflows.
 *
 * Discovers tools from user-connected MCP servers (Supabase Vault)
 * and executes individual MCP tool calls.
 */

import { createClient } from "@supabase/supabase-js";
import { createMCPClient } from "@ai-sdk/mcp";
import type { LLMToolDefinition } from "@guardian/orchestrations";
import { createLogger } from "../lib/log.js";

// ---------------------------------------------------------------------------
// MCP Server Registry (duplicated from web for bundle isolation)
// ---------------------------------------------------------------------------

type MCPServerDef = {
  id: string;
  serverUrl: string;
  toolPrefix: string;
  transport: "sse" | "http";
};

const MCP_SERVERS: MCPServerDef[] = [
  { id: "figma_console", serverUrl: "https://figma-console-mcp.southleft.com/mcp", toolPrefix: "figmaconsole_", transport: "http" },
  { id: "github", serverUrl: "https://api.githubcopilot.com/mcp", toolPrefix: "github_", transport: "http" },
  { id: "figma_mcp", serverUrl: "https://mcp.figma.com/mcp", toolPrefix: "figma_", transport: "http" },
];

function getServerDef(serverId: string): MCPServerDef | undefined {
  return MCP_SERVERS.find((s) => s.id === serverId);
}

/** Given a prefixed tool name, resolve server id + raw name. */
export function resolveServerIdFromToolName(
  prefixedName: string,
): { serverId: string; rawName: string } | undefined {
  for (const server of MCP_SERVERS) {
    if (prefixedName.startsWith(server.toolPrefix)) {
      return { serverId: server.id, rawName: prefixedName.slice(server.toolPrefix.length) };
    }
  }
  return undefined;
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
// discoverMCPTools — called once at agent workflow startup
// ---------------------------------------------------------------------------

export async function discoverMCPTools(params: {
  userId: string;
  mcpServerIds: string[];
}): Promise<LLMToolDefinition[]> {
  const log = createLogger("mcp-discover", { u: params.userId.slice(0, 8) });
  const supabase = createServiceClient();
  const tools: LLMToolDefinition[] = [];

  for (const serverId of params.mcpServerIds) {
    const serverDef = getServerDef(serverId);
    if (!serverDef) {
      log.warn(`Unknown MCP server: ${serverId}`);
      continue;
    }

    try {
      // Get token from Vault via service-role RPC
      const { data: tokensJson, error } = await supabase.rpc("get_mcp_connection_service", {
        p_user_id: params.userId,
        p_server_id: serverId,
      });

      if (error || !tokensJson) {
        log.warn(`No token for ${serverId}`, { error: error?.message });
        continue;
      }

      const tokens = JSON.parse(tokensJson);
      if (!tokens.access_token) {
        log.warn(`Token for ${serverId} has no access_token`);
        continue;
      }

      log.info(`Connecting to ${serverId}...`);

      const client = await createMCPClient({
        transport: {
          type: serverDef.transport,
          url: serverDef.serverUrl,
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        },
      });

      const mcpTools = await client.tools();
      let count = 0;
      for (const [name, tool] of Object.entries(mcpTools)) {
        tools.push({
          name: `${serverDef.toolPrefix}${name}`,
          description: (tool as { description?: string }).description ?? "",
          parameters: (tool as { parameters?: Record<string, unknown> }).parameters ?? {},
        });
        count++;
      }

      log.info(`Discovered ${count} tools from ${serverId}`);
      await client.close();
    } catch (err) {
      log.error(`Failed to discover tools from ${serverId}`, { error: String(err) });
    }
  }

  log.info(`Total external tools discovered: ${tools.length}`);
  return tools;
}

// ---------------------------------------------------------------------------
// executeMCPTool — called for each execute_external_tool effect
// ---------------------------------------------------------------------------

export async function executeMCPTool(params: {
  userId: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const log = createLogger("mcp-exec", { u: params.userId.slice(0, 8), tool: `${params.serverId}/${params.toolName}` });

  const serverDef = getServerDef(params.serverId);
  if (!serverDef) {
    return { success: false, error: `Unknown MCP server: ${params.serverId}` };
  }

  const supabase = createServiceClient();

  try {
    const { data: tokensJson, error } = await supabase.rpc("get_mcp_connection_service", {
      p_user_id: params.userId,
      p_server_id: params.serverId,
    });

    if (error || !tokensJson) {
      return { success: false, error: `No token for ${params.serverId}: ${error?.message ?? "not found"}` };
    }

    const tokens = JSON.parse(tokensJson);
    if (!tokens.access_token) {
      return { success: false, error: `Token for ${params.serverId} has no access_token` };
    }

    log.info(`Connecting to execute ${params.toolName}...`);

    const client = await createMCPClient({
      transport: {
        type: serverDef.transport,
        url: serverDef.serverUrl,
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    });

    // Get tools with execute functions, then call the target tool
    const mcpTools = await client.tools();
    const tool = mcpTools[params.toolName];
    if (!tool) {
      await client.close();
      return { success: false, error: `Tool "${params.toolName}" not found on ${params.serverId}` };
    }

    // AI SDK tools have an execute function — call it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolAny = tool as any;
    const result = await toolAny.execute(params.arguments, { toolCallId: `mcp-${Date.now()}` });
    await client.close();

    log.info(`Execution succeeded`, { result: JSON.stringify(result).slice(0, 200) });
    return { success: true, result };
  } catch (err) {
    log.error(`Execution failed`, { error: String(err) });
    return { success: false, error: String(err) };
  }
}
