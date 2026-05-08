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
import { redactArgs, redactResult } from "../lib/redact.js";

// ---------------------------------------------------------------------------
// MCP Server Registry
// ---------------------------------------------------------------------------

type MCPServerDef =
  | { id: string; toolPrefix: string; transport: "http" | "sse"; serverUrl: string }
  | { id: string; toolPrefix: string; transport: "stdio"; command: string; args: string[] };

const MCP_SERVERS: MCPServerDef[] = [
  // Guardian MCP (built-in — always available, no OAuth needed)
  { id: "guardian", serverUrl: process.env.GUARDIAN_MCP_URL ?? "http://localhost:3847/mcp", toolPrefix: "guardian_", transport: "http" },
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
  // Use anon key (not service-role) because Supabase Cloud Realtime rejects service-role connections
  if (newPort && userId && pluginClientId) {
    try {
      const anonKey = process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY ?? process.env.STORAGE_SUPABASE_ANON_KEY;
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL ?? "";
      const broadcastClient = createClient(supabaseUrl, anonKey ?? "");
      const ch = broadcastClient.channel(`guardian:execute:${userId}`);
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
  extraHeaders?: Record<string, string>,
) {
  const headers: Record<string, string> = {};
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return createMCPClient({
    transport: {
      type: serverDef.transport,
      url: serverDef.serverUrl,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
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

        // Guardian MCP uses Supabase JWT auth — use the service-role key
        // and pass the real userId via header for channel scoping
        if (serverId === "guardian") {
          const srKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;
          if (srKey) accessToken = srKey;
          log.info(`Connecting to guardian MCP (service-role auth, userId=${params.userId.slice(0, 8)})...`);
        } else {
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
        }

        log.info(`Connecting to ${serverId} (${serverDef.transport})...`);
        const guardianHeaders = serverId === "guardian" ? { "X-Guardian-User-Id": params.userId } : undefined;
        const client = await connectHTTP(serverDef, accessToken, guardianHeaders);
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
// Helpers
// ---------------------------------------------------------------------------

/** Extract text from an MCP CallToolResult content array (best-effort). */
function extractTextFromMCPResult(result: unknown): string {
  try {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      return r.content
        .filter((c: Record<string, unknown>) => c.type === "text" && typeof c.text === "string")
        .map((c: Record<string, unknown>) => c.text)
        .join("\n");
    }
  } catch { /* best-effort */ }
  return "";
}

/**
 * Detect whether a Southleft probe response indicates the cloud relay is paired
 * and the plugin is responsive. Operates on the UNESCAPED inner text (the
 * `content[].text` of the MCP CallToolResult), not the stringified outer
 * envelope — JSON.stringify of the outer result double-escapes inner JSON,
 * which broke an earlier pattern that looked for `"ok":true` literally.
 */
function isRelayAliveResponse(innerText: string): boolean {
  if (!innerText) return false;
  if (/no\s+plugin\s+connected\s+to\s+cloud\s+relay/i.test(innerText)) return false;
  return (
    innerText.includes('"available":true') ||
    innerText.includes("connectedFile") ||
    innerText.includes('"ok":true') ||
    innerText.includes('"success":true')
  );
}

// ---------------------------------------------------------------------------
// executeMCPTool — called for each execute_external_tool effect
// ---------------------------------------------------------------------------

/**
 * Pair the Guardian plugin with the Southleft cloud relay.
 *
 * Probe-first: before issuing a new pairing code (which would invalidate any
 * existing relay session — Southleft only supports one paired plugin per
 * OAuth token, see `internal/docs/backlog/fc-cloud-relay-multi-pairing.md`),
 * try a no-op `figma_execute` against Southleft. If the relay is still alive
 * (i.e. a plugin is paired and responsive), short-circuit with success and
 * skip both `figma_pair_plugin` and the broadcast.
 *
 * Otherwise call `figma_pair_plugin`, broadcast the code via Supabase Realtime
 * so the plugin auto-connects, then poll until a probe confirms the pairing.
 */
export async function pairFCCloudRelay(params: {
  userId: string;
  pluginClientId?: string;
}): Promise<{ success: boolean; code?: string; error?: string }> {
  const log = createLogger("cloud-relay", { u: params.userId.slice(0, 8) });

  const serverDef = getServerDef("figma_console");
  if (!serverDef || serverDef.transport === "stdio") {
    return { success: false, error: "figma_console server not configured" };
  }

  // Get the user's Southleft OAuth token
  const supabase = createServiceClient();
  const { data: tokensJson, error } = await supabase.rpc("get_mcp_connection_service", {
    p_user_id: params.userId,
    p_server_id: "figma_console",
  });

  if (error || !tokensJson) {
    log.warn("No Southleft token", { error: error?.message });
    return { success: false, error: "No Southleft token — user must connect Figma Console in account settings" };
  }

  const tokens = JSON.parse(tokensJson);
  if (!tokens.access_token) {
    return { success: false, error: "Southleft token has no access_token" };
  }

  // ── Probe-first: skip pairing if the relay is already alive ────────────
  log.info("Probe-first: checking if relay is already paired");
  try {
    const probeClient = await connectHTTP(serverDef as Extract<MCPServerDef, { transport: "http" | "sse" }>, tokens.access_token);
    const probeTools = await probeClient.tools();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probeTool = (probeTools["figma_get_status"] ?? probeTools["figma_execute"]) as any;
    if (probeTool) {
      const probeArgs = "figma_get_status" in probeTools ? {} : { code: "return { ok: true };" };
      const probeName = "figma_get_status" in probeTools ? "figma_get_status" : "figma_execute (no-op)";
      try {
        const probe = await probeTool.execute(probeArgs, { toolCallId: `pair-probe-${Date.now()}` });
        const inner = extractTextFromMCPResult(probe);
        if (isRelayAliveResponse(inner)) {
          await probeClient.close();
          log.info(`Probe-first: relay alive (probe=${probeName}) — skipping figma_pair_plugin`);
          return { success: true };
        }
        log.info(`Probe-first: relay not alive (probe=${probeName}) — preview=${inner.slice(0, 200)}`);
      } catch (probeErr) {
        log.info(`Probe-first: probe threw — ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`);
      }
    } else {
      log.warn("Probe-first: neither figma_get_status nor figma_execute available");
    }
    await probeClient.close();
  } catch (err) {
    log.warn(`Probe-first failed: ${err instanceof Error ? err.message : String(err)} — falling through to pair`);
  }

  try {
    // Connect to Southleft MCP and call figma_pair_plugin
    log.info("Calling figma_pair_plugin on Southleft...");
    const client = await connectHTTP(serverDef as Extract<MCPServerDef, { transport: "http" | "sse" }>, tokens.access_token);
    const tools = await client.tools();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pairTool = tools["figma_pair_plugin"] as any;

    if (!pairTool) {
      await client.close();
      return { success: false, error: "figma_pair_plugin tool not found on Southleft server" };
    }

    const result = await pairTool.execute({}, { toolCallId: `pair-${Date.now()}` });
    await client.close();

    // Extract pairing code from the result
    // figma_pair_plugin returns { pairingCode: "ABCDEF", ... } or MCP content array
    const resultText = typeof result === "string" ? result : JSON.stringify(result);
    let code: string | undefined;

    // Try structured field first
    if (result && typeof result === "object") {
      const obj = result as Record<string, unknown>;
      if (typeof obj.pairingCode === "string") {
        code = obj.pairingCode;
      }
    }

    // Fallback: extract from text (look for "pairing code" context to avoid false positives)
    if (!code) {
      const contextMatch = resultText.match(/(?:pairing\s*(?:code)?|code)\s*[:\s]*([A-HJ-NP-Z2-9]{6})/i);
      if (contextMatch) code = contextMatch[1].toUpperCase();
    }

    // Last resort: any 6-char code using Southleft's alphabet (excludes 0/O/1/I)
    if (!code) {
      const rawMatch = resultText.match(/\b([A-HJ-NP-Z2-9]{6})\b/);
      if (rawMatch) code = rawMatch[1];
    }

    if (!code) {
      log.warn("Could not extract pairing code from result", { result: resultText.slice(0, 500) });
      return { success: false, error: "Could not extract pairing code from figma_pair_plugin result" };
    }
    log.info(`Pairing code: ${code}`);

    // Broadcast the code to the plugin via Supabase Realtime
    // Use anon key (not service-role) because Supabase Cloud Realtime rejects service-role connections
    if (params.pluginClientId) {
      try {
        const anonKey = process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY ?? process.env.STORAGE_SUPABASE_ANON_KEY;
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL ?? "";
        const anonClient = createClient(supabaseUrl, anonKey ?? "");
        const ch = anonClient.channel(`guardian:execute:${params.userId}`);
        await new Promise<void>((resolve) => {
          ch.subscribe((status) => {
            if (status === "SUBSCRIBED") resolve();
          });
        });
        await ch.send({
          type: "broadcast",
          event: "connect_fc_cloud_relay",
          payload: { code, targetClientId: params.pluginClientId },
        });
        log.info(`Broadcast connect_fc_cloud_relay (code ${code}) to plugin ${params.pluginClientId}`);
        ch.unsubscribe();
      } catch (err) {
        log.warn(`Failed to broadcast connect_fc_cloud_relay: ${err}`);
      }
    }

    // Verify the relay is actually connected by probing a relay-dependent tool.
    // The broadcast → webapp → postMessage → plugin → Southleft relay chain takes 3-8s.
    // Southleft does not expose a dedicated "status" tool, so we run a no-op figma_execute
    // — if the plugin WebSocket is paired the script runs; otherwise the response contains
    // "No plugin connected to cloud relay" and we keep polling.
    let relayConnected = false;
    try {
      const statusClient = await connectHTTP(serverDef as Extract<MCPServerDef, { transport: "http" | "sse" }>, tokens.access_token);
      const statusTools = await statusClient.tools();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statusTool = (statusTools["figma_get_status"] ?? statusTools["figma_execute"]) as any;
      const probeArgs = "figma_get_status" in statusTools ? {} : { code: "return { ok: true };" };
      const probeName = "figma_get_status" in statusTools ? "figma_get_status" : "figma_execute (no-op)";
      if (statusTool) {
        let lastInnerPreview: string | null = null;
        for (let i = 0; i < 15; i++) {
          await sleep(1000);
          try {
            const status = await statusTool.execute(probeArgs, { toolCallId: `relay-wait-${i}` });
            // Extract the inner MCP CallToolResult text content. The outer
            // JSON.stringify of the raw result double-escapes inner JSON,
            // so any pattern check must run on the unescaped inner text.
            const inner = extractTextFromMCPResult(status);
            const preview = inner.slice(0, 220);
            if (preview !== lastInnerPreview && (i % 3 === 0 || preview !== lastInnerPreview)) {
              log.info(`Probe iter=${i + 1}/15 preview=${preview}`);
              lastInnerPreview = preview;
            }
            if (inner.includes("No plugin connected to cloud relay")) {
              continue; // not paired yet, keep polling
            }
            if (isRelayAliveResponse(inner)) {
              log.info(`Cloud relay connected after ${i + 1}s (probe: ${probeName})`);
              relayConnected = true;
              break;
            }
          } catch (probeErr) {
            // Distinguish "not paired yet" (transient) from real RPC errors
            const msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
            if (!msg.includes("No plugin connected")) {
              log.warn(`Probe error iter=${i}: ${msg.slice(0, 200)}`);
            }
          }
        }
        if (!relayConnected) {
          log.warn(`Cloud relay not paired after 15s (probe: ${probeName}). figmaconsole_* write tools will fail until the plugin reconnects.`);
        }
      } else {
        log.warn("Neither figma_get_status nor figma_execute available — cannot verify relay pairing");
      }
      await statusClient.close();
    } catch (err) {
      log.warn(`Relay verification failed: ${err}`);
    }

    return { success: relayConnected, code, error: relayConnected ? undefined : "Cloud relay broadcast sent but pairing was not verified within 15s" };
  } catch (err) {
    log.error(`pairFCCloudRelay failed: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, error: `Cloud relay pairing failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Figma Console rewriters
// ---------------------------------------------------------------------------
// The Southleft Figma Console MCP is built for clients that don't have our
// auto-pairing. Its raw responses leak its manual flow into the LLM:
//   - figma_pair_plugin returns { pairingCode, instructions: ["Click ▶ Cloud Mode", ...] }
//   - figma_execute returns "No plugin connected to cloud relay. User must pair... use figma_pair_plugin tool."
// Guardian already handles pairing automatically (pairFCCloudRelay broadcasts the
// code via Realtime, the plugin auto-connects). These rewriters intercept
// Southleft's raw responses so the LLM never sees the manual flow.

const NO_PLUGIN_CONNECTED_PATTERN = /no\s+plugin\s+connected\s+to\s+cloud\s+relay/i;

/**
 * Pre-execute interceptor for figma_pair_plugin.
 *
 * When the LLM calls figma_pair_plugin directly, run pairFCCloudRelay
 * internally and return a neutral result that does NOT expose the pairing code
 * or manual instructions. Tells the LLM to retry whatever it was doing.
 */
async function interceptFigmaPairCall(params: {
  userId: string;
  pluginClientId?: string;
}): Promise<unknown> {
  const pair = await pairFCCloudRelay({
    userId: params.userId,
    pluginClientId: params.pluginClientId,
  });
  if (pair.success) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "paired",
            note: "Auto-pairing handled by Guardian. The Figma plugin is connected via the cloud relay. Retry your previous tool call.",
          }),
        },
      ],
      isError: false,
    };
  }
  // Pairing failed — surface a Guardian-flavoured error, NOT Southleft's manual flow.
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "not_paired",
          error:
            pair.error ??
            "Cloud relay pairing failed. The Guardian plugin is not running in Figma. Ask the user to open Figma Desktop with the Guardian plugin, then retry.",
        }),
      },
    ],
    isError: true,
  };
}

/**
 * Detect the Southleft "no plugin connected to cloud relay" error in a result
 * payload (string, MCP CallToolResult content array, or generic object).
 */
function isNoPluginConnectedError(result: unknown, errorText?: string): boolean {
  if (errorText && NO_PLUGIN_CONNECTED_PATTERN.test(errorText)) return true;
  if (typeof result === "string") return NO_PLUGIN_CONNECTED_PATTERN.test(result);
  if (result && typeof result === "object") {
    try {
      return NO_PLUGIN_CONNECTED_PATTERN.test(JSON.stringify(result));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Rewrite Southleft's "No plugin connected to cloud relay. User must pair..."
 * error into a Guardian-context message. Used when the auto-pair recovery
 * also fails — we don't want to leak Southleft's manual instructions.
 */
function rewriteNoPluginConnectedError(): string {
  return "Guardian plugin is not running in Figma. Ask the user to open Figma Desktop and launch the Guardian plugin, then retry. (Pairing is automatic — no manual code entry needed.)";
}

export async function executeMCPTool(params: {
  userId: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  agentId?: string;
  pluginClientId?: string;
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

  // ── Figma Console interceptor: figma_pair_plugin ───────────────────────────
  // Pairing is internal to Guardian. The LLM must never see Southleft's
  // pairing code or manual instructions. Re-pair via pairFCCloudRelay and
  // return a neutral result.
  const isFigmaConsole = params.serverId === "figma_console" || params.serverId === "figma_console_local";
  if (isFigmaConsole && params.toolName === "figma_pair_plugin") {
    log.info("Intercepting figma_pair_plugin — running Guardian auto-pair instead");
    const result = await interceptFigmaPairCall({
      userId: params.userId,
      pluginClientId: params.pluginClientId,
    });
    const isError = (result as { isError?: boolean }).isError === true;
    return isError
      ? { success: false, result, error: extractTextFromMCPResult(result) || "pair failed" }
      : { success: true, result };
  }

  // Inner exec helper — runs the actual MCP call. Used twice if we need to
  // recover from "No plugin connected to cloud relay" by re-pairing.
  const runOnce = async (): Promise<{ success: boolean; result?: unknown; error?: string }> => {
    return runMCPToolCall(params, serverDef, log);
  };

  let outcome = await runOnce();

  // ── Figma Console recovery: "No plugin connected to cloud relay" ───────────
  // Auto-pair may have failed, the plugin may have reloaded, or the relay
  // may have dropped between turns. Re-pair on demand and retry once.
  if (
    isFigmaConsole &&
    !outcome.success &&
    isNoPluginConnectedError(outcome.result, outcome.error)
  ) {
    log.warn("Figma Console returned 'no plugin connected' — re-pairing and retrying once");
    const pair = await pairFCCloudRelay({
      userId: params.userId,
      pluginClientId: params.pluginClientId,
    });
    if (pair.success) {
      outcome = await runOnce();
      if (!outcome.success && isNoPluginConnectedError(outcome.result, outcome.error)) {
        outcome = { ...outcome, error: rewriteNoPluginConnectedError() };
      }
    } else {
      outcome = { ...outcome, error: rewriteNoPluginConnectedError() };
    }
  }

  return outcome;
}

/**
 * Inner MCP call dispatcher. Extracted so executeMCPTool can retry the same
 * call after a re-pair attempt without duplicating the stdio/HTTP branches.
 */
async function runMCPToolCall(
  params: {
    userId: string;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    agentId?: string;
  },
  serverDef: MCPServerDef,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any,
): Promise<{ success: boolean; result?: unknown; error?: string }> {

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

      log.info(`Executing via persistent stdio client...`, redactArgs(params.arguments));
      const result = await tool.execute(params.arguments, { toolCallId: `mcp-${Date.now()}` });
      entry.lastUsed = Date.now();
      // MCP CallToolResult may have isError: true even when the transport succeeds
      if (result && typeof result === "object" && (result as Record<string, unknown>).isError) {
        const textContent = extractTextFromMCPResult(result);
        log.warn(`Execution returned isError`, { req: params.toolName, errorLen: textContent.length });
        return { success: false, result, error: textContent || "Tool reported an error" };
      }
      log.info(`Execution succeeded`, redactResult(result));
      return { success: true, result };
    }

    // HTTP/SSE: stateless, create → execute → close
    let accessToken: string | undefined;

    if (params.serverId === "guardian") {
      // Guardian MCP uses service-role key as Bearer token
      accessToken = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;
    } else {
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
    }

    log.info(`Connecting to execute ${params.toolName} (${serverDef.transport})...`);
    const guardianHeaders = params.serverId === "guardian" ? { "X-Guardian-User-Id": params.userId } : undefined;
    const client = await connectHTTP(serverDef, accessToken, guardianHeaders);
    const mcpTools = await client.tools();
    const tool = mcpTools[params.toolName];
    if (!tool) {
      await client.close();
      return { success: false, error: `Tool "${params.toolName}" not found on ${params.serverId}` };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute(params.arguments, { toolCallId: `mcp-${Date.now()}` });
    await client.close();
    // MCP CallToolResult may have isError: true even when the transport succeeds
    if (result && typeof result === "object" && (result as Record<string, unknown>).isError) {
      const textContent = extractTextFromMCPResult(result);
      log.warn(`Execution returned isError`, { req: params.toolName, errorLen: textContent.length });
      return { success: false, result, error: textContent || "Tool reported an error" };
    }
    log.info(`Execution succeeded`, redactResult(result));
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
