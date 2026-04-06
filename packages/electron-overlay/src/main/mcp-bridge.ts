/**
 * Guardian MCP Bridge — runs in the Electron overlay main process.
 *
 * Subscribes to Supabase Realtime on guardian:mcp:${userId}:${deviceId},
 * handles mcp-request events by dispatching to local MCP clients (HTTP / SSE / stdio),
 * and publishes mcp-response events back.
 *
 * Also publishes a periodic heartbeat on guardian:devices:${userId} so the
 * webapp and Temporal worker can detect whether the bridge is online.
 *
 * Config is read from:
 *   1. Environment variables (dev)
 *   2. A config file in Electron userData (written by Phase 3 Account pairing)
 *   3. If neither → bridge stays inactive
 */

import { createClient as createSupabaseClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { hostname } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  mcpChannelName,
  devicesChannelName,
  MCP_REQUEST_EVENT,
  MCP_RESPONSE_EVENT,
  BRIDGE_HELLO_EVENT,
  BUILTIN_PRESETS,
  type MCPBridgeRequest,
  type MCPBridgeResponse,
  type BridgeHeartbeat,
  type BridgeHeartbeatInstance,
} from "@guardian/orchestrations";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BridgeConfig {
  userId: string;
  deviceId: string;
  deviceFingerprint: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  instances: LocalInstanceConfig[];
}

export interface LocalInstanceConfig {
  instanceId: string;
  label: string;
  presetType: string;
  /** HTTP or SSE URL for http/sse transport. */
  url?: string;
  /** Override transport (default derived from preset). */
  transport?: "http" | "sse" | "stdio";
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const CLIENT_RETRY_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Fingerprint — stable UUID per machine, stored in Electron userData
// ---------------------------------------------------------------------------

export function getOrCreateFingerprint(userDataPath: string): string {
  const fpPath = join(userDataPath, "guardian-device-fingerprint");
  try {
    const existing = readFileSync(fpPath, "utf-8").trim();
    if (existing) return existing;
  } catch { /* file doesn't exist yet */ }
  const fp = randomUUID();
  try { writeFileSync(fpPath, fp); } catch { /* non-fatal */ }
  return fp;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

export function loadBridgeConfig(userDataPath: string): BridgeConfig | null {
  // 1. Environment variables (dev mode)
  const envUserId = process.env["GUARDIAN_USER_ID"];
  const envDeviceId = process.env["GUARDIAN_DEVICE_ID"];
  if (envUserId && envDeviceId) {
    const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? process.env["STORAGE_SUPABASE_URL"] ?? "";
    const supabaseAnonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ?? process.env["STORAGE_SUPABASE_ANON_KEY"] ?? "";
    if (!supabaseUrl || !supabaseAnonKey) return null;

    const instancesJson = process.env["GUARDIAN_BRIDGE_INSTANCES"];
    let instances: LocalInstanceConfig[] = [];
    if (instancesJson) {
      try { instances = JSON.parse(instancesJson); } catch { /* ignore */ }
    }

    return {
      userId: envUserId,
      deviceId: envDeviceId,
      deviceFingerprint: getOrCreateFingerprint(userDataPath),
      supabaseUrl,
      supabaseAnonKey,
      instances,
    };
  }

  // 2. Config file (written by webapp Account pairing — Phase 3)
  const configPath = join(userDataPath, "guardian-bridge.json");
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as BridgeConfig;
      if (raw.userId && raw.deviceId && raw.supabaseUrl && raw.supabaseAnonKey) {
        raw.deviceFingerprint = getOrCreateFingerprint(userDataPath);
        return raw;
      }
    } catch { /* ignore malformed file */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Local MCP client pool
// ---------------------------------------------------------------------------

type MCPClientEntry = {
  instanceId: string;
  label: string;
  presetType: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  online: boolean;
  error?: string;
};

// ---------------------------------------------------------------------------
// GuardianBridge class
// ---------------------------------------------------------------------------

export class GuardianBridge {
  private config: BridgeConfig;
  private supabase: SupabaseClient;
  private mcpChannel: RealtimeChannel | null = null;
  private devicesChannel: RealtimeChannel | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private localClients = new Map<string, MCPClientEntry>();
  private running = false;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.supabase = createSupabaseClient(config.supabaseUrl, config.supabaseAnonKey);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log(`[mcp-bridge] Starting bridge for user=${this.config.userId.slice(0, 8)} device=${this.config.deviceId.slice(0, 8)}`);
    console.log(`[mcp-bridge] ${this.config.instances.length} local instance(s) configured`);

    // Create local MCP clients
    await this.initLocalClients();

    // Subscribe to the device-scoped MCP channel
    const channelName = mcpChannelName(this.config.userId, this.config.deviceId);
    this.mcpChannel = this.supabase.channel(channelName);

    this.mcpChannel.on(
      "broadcast",
      { event: MCP_REQUEST_EVENT },
      ({ payload }: { payload: MCPBridgeRequest }) => {
        this.handleRequest(payload).catch((err) =>
          console.error("[mcp-bridge] handleRequest error:", err),
        );
      },
    );

    this.mcpChannel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log(`[mcp-bridge] Subscribed to ${channelName}`);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error(`[mcp-bridge] Channel subscription failed: ${status}`);
      }
    });

    // Start heartbeat
    this.startHeartbeat();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    console.log("[mcp-bridge] Stopping bridge...");

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.mcpChannel) {
      this.mcpChannel.unsubscribe();
      this.mcpChannel = null;
    }

    if (this.devicesChannel) {
      this.devicesChannel.unsubscribe();
      this.devicesChannel = null;
    }

    // Close local MCP clients
    for (const [key, entry] of this.localClients) {
      try { await entry.client.close(); } catch { /* ignore */ }
      console.log(`[mcp-bridge] Closed local client: ${key}`);
    }
    this.localClients.clear();
  }

  // ── Local MCP clients ─────────────────────────────────────────────────────

  private async initLocalClients(): Promise<void> {
    for (const inst of this.config.instances) {
      await this.createLocalClient(inst);
    }
  }

  private async createLocalClient(inst: LocalInstanceConfig): Promise<void> {
    const preset = BUILTIN_PRESETS[inst.presetType];
    const transport = inst.transport ?? preset?.transport ?? "http";

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let client: any;

      if (transport === "stdio" && preset) {
        const command = preset.stdio_command;
        const args = preset.stdio_args ?? [];
        if (!command) throw new Error(`No stdio_command for preset ${inst.presetType}`);

        console.log(`[mcp-bridge] Spawning stdio client: ${command} ${args.join(" ")}`);
        const stdioTransport = new Experimental_StdioMCPTransport({ command, args });
        client = await createMCPClient({ transport: stdioTransport });
      } else {
        // HTTP or SSE
        const url = inst.url ?? preset?.default_local_url;
        if (!url) throw new Error(`No URL for instance ${inst.label}`);

        console.log(`[mcp-bridge] Connecting to ${transport} client: ${url}`);
        client = await createMCPClient({
          transport: { type: transport as "http" | "sse", url },
        });
      }

      const tools = await client.tools();
      const toolCount = Object.keys(tools).length;
      console.log(`[mcp-bridge] ✓ ${inst.label}: ${toolCount} tools`);

      this.localClients.set(inst.instanceId, {
        instanceId: inst.instanceId,
        label: inst.label,
        presetType: inst.presetType,
        client,
        tools,
        online: true,
      });
    } catch (err) {
      console.error(`[mcp-bridge] ✗ ${inst.label}: ${err}`);
      this.localClients.set(inst.instanceId, {
        instanceId: inst.instanceId,
        label: inst.label,
        presetType: inst.presetType,
        client: null,
        tools: {},
        online: false,
        error: String(err),
      });

      // Retry after delay
      setTimeout(() => {
        if (!this.running) return;
        console.log(`[mcp-bridge] Retrying ${inst.label}...`);
        this.createLocalClient(inst).catch(() => {});
      }, CLIENT_RETRY_DELAY_MS);
    }
  }

  // ── Request handler ───────────────────────────────────────────────────────

  private async handleRequest(req: MCPBridgeRequest): Promise<void> {
    // Safety: ignore requests not addressed to this device
    if (req.targetDeviceId !== this.config.deviceId) return;

    // Check deadline
    if (Date.now() > req.deadline) {
      console.warn(`[mcp-bridge] Request ${req.requestId.slice(0, 8)} expired before handling`);
      return; // don't respond to expired requests
    }

    const entry = this.localClients.get(req.instanceId);
    if (!entry || !entry.online || !entry.client) {
      this.publishResponse(req.requestId, {
        ok: false,
        error: entry
          ? `Instance "${entry.label}" is offline: ${entry.error ?? "client not ready"}`
          : `Unknown instance ${req.instanceId}`,
      });
      return;
    }

    try {
      if (req.method === "tools/list") {
        // Refresh tools (they may have changed since last discovery)
        entry.tools = await entry.client.tools();
        const toolList = Object.entries(entry.tools).map(([name, tool]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = tool as any;
          return {
            name,
            description: t.description ?? "",
            parameters: t.parameters ?? t.inputSchema?.jsonSchema ?? {},
          };
        });
        this.publishResponse(req.requestId, { ok: true, result: toolList });
      } else {
        // tools/call
        const toolName = req.params?.name;
        if (!toolName) {
          this.publishResponse(req.requestId, { ok: false, error: "Missing tool name" });
          return;
        }

        // Refresh tools if the requested tool is not found (lazy refresh)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let tool: any = entry.tools[toolName];
        if (!tool) {
          entry.tools = await entry.client.tools();
          tool = entry.tools[toolName];
        }
        if (!tool) {
          this.publishResponse(req.requestId, {
            ok: false,
            error: `Tool "${toolName}" not found on ${entry.label}`,
          });
          return;
        }

        const result = await tool.execute(req.params?.arguments ?? {}, {
          toolCallId: req.requestId,
        });

        // Check for MCP-level errors (isError in CallToolResult)
        if (result && typeof result === "object" && (result as Record<string, unknown>).isError) {
          this.publishResponse(req.requestId, {
            ok: false,
            error: this.extractText(result) || "Tool reported an error",
          });
          return;
        }

        this.publishResponse(req.requestId, { ok: true, result });
      }
    } catch (err) {
      console.error(`[mcp-bridge] Execution error on ${entry.label}:`, err);
      this.publishResponse(req.requestId, {
        ok: false,
        error: `Execution failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private publishResponse(
    requestId: string,
    body: { ok: boolean; result?: unknown; error?: string },
  ): void {
    const response: MCPBridgeResponse = {
      type: "mcp-response",
      requestId,
      ok: body.ok,
      result: body.result,
      error: body.error,
    };

    this.mcpChannel?.send({
      type: "broadcast",
      event: MCP_RESPONSE_EVENT,
      payload: response,
    });
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    const channelName = devicesChannelName(this.config.userId);
    this.devicesChannel = this.supabase.channel(channelName);

    this.devicesChannel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log(`[mcp-bridge] Heartbeat channel subscribed: ${channelName}`);
        this.publishHeartbeat(); // immediate first heartbeat
      }
    });

    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return;
      this.publishHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private publishHeartbeat(): void {
    const instances: BridgeHeartbeatInstance[] = [];
    for (const entry of this.localClients.values()) {
      instances.push({
        instanceId: entry.instanceId,
        label: entry.label,
        presetType: entry.presetType,
        online: entry.online,
        toolCount: Object.keys(entry.tools).length,
        error: entry.error,
      });
    }

    const heartbeat: BridgeHeartbeat = {
      type: "bridge-hello",
      deviceId: this.config.deviceId,
      deviceName: hostname(),
      overlayVersion: process.env["npm_package_version"] ?? "unknown",
      osInfo: `${process.platform} ${process.arch}`,
      instances,
      publishedAt: Date.now(),
    };

    this.devicesChannel?.send({
      type: "broadcast",
      event: BRIDGE_HELLO_EVENT,
      payload: heartbeat,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private extractText(result: unknown): string {
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

  /** Expose client statuses for the tray menu. */
  getStatus(): { running: boolean; instances: BridgeHeartbeatInstance[] } {
    const instances: BridgeHeartbeatInstance[] = [];
    for (const entry of this.localClients.values()) {
      instances.push({
        instanceId: entry.instanceId,
        label: entry.label,
        presetType: entry.presetType,
        online: entry.online,
        toolCount: Object.keys(entry.tools).length,
        error: entry.error,
      });
    }
    return { running: this.running, instances };
  }
}
