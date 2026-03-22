/**
 * MCP activities for Temporal workflows.
 *
 * Discovers tools from user-connected MCP servers (Supabase Vault)
 * and executes individual MCP tool calls.
 *
 * Supports both remote (HTTP + OAuth) and local (stdio) MCP servers.
 * Stdio clients are kept alive in a persistent pool (1 per agent) to avoid
 * launching a new subprocess per tool call — the Guardian plugin needs time
 * (~15s rescan) to connect to the subprocess's WS server.
 */

import { createClient } from "@supabase/supabase-js";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { LLMToolDefinition } from "@guardian/orchestrations";
import { createLogger } from "../lib/log.js";

// ---------------------------------------------------------------------------
// MCP Server Registry
// ---------------------------------------------------------------------------

type MCPServerDef =
  | { id: string; toolPrefix: string; transport: "http" | "sse"; serverUrl: string }
  | { id: string; toolPrefix: string; transport: "stdio"; command: string; args: string[] };

const MCP_SERVERS: MCPServerDef[] = [
  // Remote servers (OAuth token from Vault)
  { id: "figma_console", serverUrl: "https://figma-console-mcp.southleft.com/mcp", toolPrefix: "figmaconsole_", transport: "http" },
  { id: "github", serverUrl: "https://api.githubcopilot.com/mcp", toolPrefix: "github_", transport: "http" },
  { id: "figma_mcp", serverUrl: "https://mcp.figma.com/mcp", toolPrefix: "figma_", transport: "http" },
  // Local server (stdio, no auth needed — connects to Guardian plugin via WebSocket)
  { id: "figma_console_local", toolPrefix: "figmaconsole_", transport: "stdio", command: "npx", args: ["figma-console-mcp@latest"] },
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
// Persistent stdio client pool (1 subprocess per agent)
// ---------------------------------------------------------------------------
// Module-level state — survives between activity invocations in the same
// Temporal worker process. Each agent gets its own subprocess to avoid
// stdin/stdout conflicts in parallel execution.

type PoolEntry = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  lastUsed: number;
};

const stdioPool = new Map<string, PoolEntry>();
const POOL_TTL_MS = 10 * 60 * 1000; // 10 min idle → close subprocess

const poolLog = createLogger("mcp-pool");

// Periodic cleanup of idle subprocesses.
// unref() so this timer doesn't prevent process exit during --watch restarts.
const poolCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stdioPool) {
    if (now - entry.lastUsed > POOL_TTL_MS) {
      poolLog.info(`Closing idle stdio client: ${key}`);
      try { entry.client.close(); } catch { /* ignore */ }
      stdioPool.delete(key);
    }
  }
}, 60_000);
poolCleanupTimer.unref();

async function getOrCreateStdioClient(
  serverDef: Extract<MCPServerDef, { transport: "stdio" }>,
  poolKey: string,
): Promise<PoolEntry> {
  const existing = stdioPool.get(poolKey);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  poolLog.info(`Creating persistent stdio client: ${poolKey} (${serverDef.command} ${serverDef.args.join(" ")})`);

  const transport = new Experimental_StdioMCPTransport({
    command: serverDef.command,
    args: serverDef.args,
  });
  const client = await createMCPClient({ transport });
  const tools = await client.tools();

  poolLog.info(`Stdio client ready: ${poolKey} — ${Object.keys(tools).length} tools`);

  const entry: PoolEntry = { client, tools, lastUsed: Date.now() };
  stdioPool.set(poolKey, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// HTTP/SSE client creation (stateless, one-shot)
// ---------------------------------------------------------------------------

async function connectHTTP(
  serverDef: Extract<MCPServerDef, { transport: "http" | "sse" }>,
  accessToken?: string,
) {
  return createMCPClient({
    transport: {
      type: serverDef.transport,
      url: serverDef.serverUrl,
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// discoverMCPTools — called once at agent workflow startup
// ---------------------------------------------------------------------------

export async function discoverMCPTools(params: {
  userId: string;
  mcpServerIds: string[];
  agentId?: string;
}): Promise<LLMToolDefinition[]> {
  const log = createLogger("mcp-discover", { u: params.userId.slice(0, 8), agent: params.agentId });
  const supabase = createServiceClient();
  const tools: LLMToolDefinition[] = [];

  for (const serverId of params.mcpServerIds) {
    const serverDef = getServerDef(serverId);
    if (!serverDef) {
      log.warn(`Unknown MCP server: ${serverId}`);
      continue;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mcpTools: Record<string, any>;

      if (serverDef.transport === "stdio") {
        // Use persistent pool — subprocess stays alive for subsequent executeMCPTool calls
        const poolKey = `${serverId}:${params.agentId ?? "default"}`;
        const entry = await getOrCreateStdioClient(serverDef, poolKey);
        mcpTools = entry.tools;
        // NO client.close() — stays in pool
      } else {
        // HTTP/SSE: stateless, one-shot
        let accessToken: string | undefined;
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
        accessToken = tokens.access_token;

        log.info(`Connecting to ${serverId} (${serverDef.transport})...`);
        const client = await connectHTTP(serverDef, accessToken);
        mcpTools = await client.tools();
        await client.close();
      }

      let count = 0;
      for (const [name, tool] of Object.entries(mcpTools)) {
        // AI SDK MCP client returns the schema in inputSchema.jsonSchema (not parameters)
        const toolAny = tool as { description?: string; parameters?: Record<string, unknown>; inputSchema?: { jsonSchema?: Record<string, unknown> } };
        const parameters = toolAny.parameters ?? toolAny.inputSchema?.jsonSchema ?? {};
        tools.push({
          name: `${serverDef.toolPrefix}${name}`,
          description: toolAny.description ?? "",
          parameters,
        });
        count++;
      }

      log.info(`Discovered ${count} tools from ${serverId}`);
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
  agentId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const log = createLogger("mcp-exec", {
    u: params.userId.slice(0, 8),
    agent: params.agentId,
    tool: `${params.serverId}/${params.toolName}`,
  });

  const serverDef = getServerDef(params.serverId);
  if (!serverDef) {
    return { success: false, error: `Unknown MCP server: ${params.serverId}` };
  }

  try {
    if (serverDef.transport === "stdio") {
      // Use persistent pool — reuse subprocess from discoverMCPTools
      const poolKey = `${params.serverId}:${params.agentId ?? "default"}`;
      const entry = await getOrCreateStdioClient(serverDef, poolKey);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let tool: any = entry.tools[params.toolName];
      if (!tool) {
        // Tools may have changed since discovery — refresh
        log.info(`Tool "${params.toolName}" not in cache, refreshing...`);
        entry.tools = await entry.client.tools();
        entry.lastUsed = Date.now();
        tool = entry.tools[params.toolName];
      }
      if (!tool) {
        return { success: false, error: `Tool "${params.toolName}" not found on ${params.serverId}` };
      }

      log.info(`Executing via persistent stdio client...`, { args: JSON.stringify(params.arguments).slice(0, 500) });
      const result = await tool.execute(params.arguments, { toolCallId: `mcp-${Date.now()}` });
      entry.lastUsed = Date.now();
      log.info(`Execution succeeded`, { result: JSON.stringify(result).slice(0, 200) });
      return { success: true, result };
    }

    // HTTP/SSE: stateless, create → execute → close
    let accessToken: string | undefined;
    const supabase = createServiceClient();
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
    accessToken = tokens.access_token;

    log.info(`Connecting to execute ${params.toolName} (${serverDef.transport})...`);
    const client = await connectHTTP(serverDef, accessToken);
    const mcpTools = await client.tools();
    const tool = mcpTools[params.toolName];
    if (!tool) {
      await client.close();
      return { success: false, error: `Tool "${params.toolName}" not found on ${params.serverId}` };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute(params.arguments, { toolCallId: `mcp-${Date.now()}` });
    await client.close();
    log.info(`Execution succeeded`, { result: JSON.stringify(result).slice(0, 200) });
    return { success: true, result };
  } catch (err) {
    // If stdio client crashed, remove from pool so next call creates a fresh one
    if (serverDef.transport === "stdio") {
      const poolKey = `${params.serverId}:${params.agentId ?? "default"}`;
      const entry = stdioPool.get(poolKey);
      if (entry) {
        poolLog.info(`Removing crashed stdio client: ${poolKey}`);
        try { entry.client.close(); } catch { /* ignore */ }
        stdioPool.delete(poolKey);
      }
    }
    log.error(`Execution failed`, { error: String(err) });
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// closeStdioPool — explicit cleanup (called at orchestration end or on demand)
// ---------------------------------------------------------------------------

export async function closeStdioPool(params: { agentId?: string }): Promise<void> {
  for (const [key, entry] of stdioPool) {
    if (!params.agentId || key.endsWith(`:${params.agentId}`)) {
      poolLog.info(`Closing stdio client: ${key}`);
      try { entry.client.close(); } catch { /* ignore */ }
      stdioPool.delete(key);
    }
  }
}
