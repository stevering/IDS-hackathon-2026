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
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  /** PID of the child process — grabbed right after spawn so we can kill it
   *  even if `client.close()` fails to terminate the subprocess. */
  pid?: number;
};

const stdioPool = new Map<string, PoolEntry>();
const POOL_TTL_MS = 10 * 60 * 1000; // 10 min idle → close subprocess

const poolLog = createLogger("mcp-pool");

/** Kill a pool entry's subprocess. Tries client.close() first, then SIGTERM on PID. */
function killPoolEntry(key: string, entry: PoolEntry): void {
  try { entry.client.close(); } catch { /* ignore */ }
  if (entry.pid) {
    try {
      process.kill(entry.pid, "SIGTERM");
      poolLog.info(`Sent SIGTERM to subprocess PID ${entry.pid} (${key})`);
    } catch {
      // Process already exited — ignore ESRCH
    }
  }
  stdioPool.delete(key);
}

// Periodic cleanup of idle subprocesses.
// unref() so this timer doesn't prevent process exit during --watch restarts.
const poolCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stdioPool) {
    if (now - entry.lastUsed > POOL_TTL_MS) {
      poolLog.info(`Closing idle stdio client: ${key}`);
      killPoolEntry(key, entry);
    }
  }
}, 60_000);
poolCleanupTimer.unref();

// Safety net: kill all subprocesses on SIGTERM/SIGINT if the normal shutdown
// path in worker.ts doesn't run (e.g. parent process killed, crash).
function emergencyPoolCleanup(signal: string): void {
  if (stdioPool.size === 0) return;
  poolLog.info(`Emergency cleanup on ${signal} — killing ${stdioPool.size} subprocess(es)`);
  for (const [key, entry] of stdioPool) {
    killPoolEntry(key, entry);
  }
}

process.on("SIGTERM", () => emergencyPoolCleanup("SIGTERM"));
process.on("SIGINT", () => emergencyPoolCleanup("SIGINT"));
process.on("beforeExit", () => emergencyPoolCleanup("beforeExit"));

// ---------------------------------------------------------------------------
// Port file helpers — FC MCP subprocess publishes its WS port in /tmp
// ---------------------------------------------------------------------------

const PORT_FILE_PREFIX = "figma-console-mcp-";

function listPortFiles(): Array<{ port: number; pid: number; startedAt: string }> {
  try {
    const dir = tmpdir();
    return readdirSync(dir)
      .filter((f) => f.startsWith(PORT_FILE_PREFIX) && f.endsWith(".json"))
      .map((f) => {
        try {
          const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
          return { port: data.port, pid: data.pid, startedAt: data.startedAt };
        } catch { return null; }
      })
      .filter((d): d is { port: number; pid: number; startedAt: string } => d !== null);
  } catch { return []; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// getOrCreateStdioClient — creates subprocess, notifies plugin, waits for WS
// ---------------------------------------------------------------------------

async function getOrCreateStdioClient(
  serverDef: Extract<MCPServerDef, { transport: "stdio" }>,
  poolKey: string,
  userId?: string,
  pluginClientId?: string,
): Promise<PoolEntry> {
  const existing = stdioPool.get(poolKey);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  poolLog.info(`Creating persistent stdio client: ${poolKey} (${serverDef.command} ${serverDef.args.join(" ")})`);

  // Snapshot port files BEFORE creating subprocess
  const portsBefore = new Set(listPortFiles().map((p) => p.port));

  const transport = new Experimental_StdioMCPTransport({
    command: serverDef.command,
    args: serverDef.args,
  });
  const client = await createMCPClient({ transport });
  const tools = await client.tools();

  // Grab the subprocess PID before anything can clear it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pid = (transport as any).process?.pid as number | undefined;

  poolLog.info(`Stdio client ready: ${poolKey} — ${Object.keys(tools).length} tools, PID ${pid ?? "unknown"}`);

  const entry: PoolEntry = { client, tools, lastUsed: Date.now(), pid };
  stdioPool.set(poolKey, entry);

  // Discover the new subprocess's WS port by diffing port files
  let newPort: number | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    const portsAfter = listPortFiles();
    const fresh = portsAfter.find((p) => !portsBefore.has(p.port));
    if (fresh) {
      newPort = fresh.port;
      break;
    }
    await sleep(500);
  }

  if (newPort) {
    poolLog.info(`Port found: ${newPort} for ${poolKey}`);
  } else {
    poolLog.warn(`Could not discover port for ${poolKey} — plugin will rely on periodic scan`);
  }

  // Notify the Guardian plugin to connect to this port immediately
  if (newPort && userId && pluginClientId) {
    try {
      const supabase = createServiceClient();
      const ch = supabase.channel(`guardian:execute:${userId}`);
      await new Promise<void>((resolve) => {
        ch.subscribe((status) => {
          if (status === "SUBSCRIBED") resolve();
        });
      });
      await ch.send({
        type: "broadcast",
        event: "connect_fc_port",
        payload: { port: newPort, targetClientId: pluginClientId },
      });
      poolLog.info(`Broadcast connect_fc_port (port ${newPort}) to plugin ${pluginClientId}`);
      ch.unsubscribe();
    } catch (err) {
      poolLog.warn(`Failed to broadcast connect_fc_port: ${err}`);
    }
  }

  // Wait for the plugin to connect to the subprocess's WS
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statusTool = tools["figma_get_status"] as any;
  if (statusTool && newPort) {
    poolLog.info(`Waiting for plugin to connect to port ${newPort}...`);
    for (let i = 0; i < 15; i++) {
      try {
        const status = await statusTool.execute({}, { toolCallId: `wait-${i}` });
        const statusStr = JSON.stringify(status);
        if (statusStr.includes('"available":true') || statusStr.includes("connectedFile")) {
          poolLog.info(`Plugin connected to subprocess on port ${newPort}`);
          break;
        }
      } catch { /* ignore — subprocess may not be ready yet */ }
      await sleep(1000);
    }
  }

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
  pluginClientId?: string;
}): Promise<LLMToolDefinition[]> {
  const log = createLogger("mcp-discover", { u: params.userId.slice(0, 8), agent: params.agentId });
  const supabase = createServiceClient();
  const tools: LLMToolDefinition[] = [];

  // Track which prefixes are already covered (to avoid duplicates)
  const coveredPrefixes = new Set<string>();

  // Process stdio servers first (local = superset of remote for same prefix)
  const sortedIds = [...params.mcpServerIds].sort((a, b) => {
    const aDef = getServerDef(a);
    const bDef = getServerDef(b);
    if (aDef?.transport === "stdio" && bDef?.transport !== "stdio") return -1;
    if (aDef?.transport !== "stdio" && bDef?.transport === "stdio") return 1;
    return 0;
  });

  for (const serverId of sortedIds) {
    const serverDef = getServerDef(serverId);
    if (!serverDef) {
      log.warn(`Unknown MCP server: ${serverId}`);
      continue;
    }

    // Skip if a local server already covers this prefix (e.g. figma_console_local covers figmaconsole_)
    if (coveredPrefixes.has(serverDef.toolPrefix)) {
      log.info(`Skipping ${serverId} — prefix "${serverDef.toolPrefix}" already covered by local server`);
      continue;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mcpTools: Record<string, any>;

      if (serverDef.transport === "stdio") {
        // Stdio servers only work in local dev (subprocess needs local Figma Desktop)
        if (process.env.NODE_ENV === "production" && process.env.ENABLE_LOCAL_MCP !== "true") {
          log.warn(`Skipping stdio server ${serverId} in production`);
          continue;
        }
        // Use persistent pool — subprocess stays alive for subsequent executeMCPTool calls
        const poolKey = `${serverId}:${params.agentId ?? "default"}`;
        const entry = await getOrCreateStdioClient(serverDef, poolKey, params.userId, params.pluginClientId);
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
      if (count > 0) coveredPrefixes.add(serverDef.toolPrefix);
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
      // Stdio servers only work in local dev
      if (process.env.NODE_ENV === "production" && process.env.ENABLE_LOCAL_MCP !== "true") {
        return { success: false, error: `Stdio MCP server "${params.serverId}" not available in production` };
      }
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
    // If stdio client crashed, kill subprocess and remove from pool
    if (serverDef.transport === "stdio") {
      const poolKey = `${params.serverId}:${params.agentId ?? "default"}`;
      const entry = stdioPool.get(poolKey);
      if (entry) {
        poolLog.info(`Removing crashed stdio client: ${poolKey} (PID ${entry.pid ?? "unknown"})`);
        killPoolEntry(poolKey, entry);
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
      poolLog.info(`Closing stdio client: ${key} (PID ${entry.pid ?? "unknown"})`);
      killPoolEntry(key, entry);
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers — exposed for unit tests only
// ---------------------------------------------------------------------------

export const _testing = {
  stdioPool,
  killPoolEntry,
  type: undefined as unknown as PoolEntry, // type export trick
};
