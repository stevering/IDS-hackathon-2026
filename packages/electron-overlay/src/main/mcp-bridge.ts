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
  INSTANCE_CHANGED_EVENT,
  BUILTIN_PRESETS,
  type MCPBridgeRequest,
  type MCPBridgeResponse,
  type BridgeHeartbeat,
  type BridgeHeartbeatInstance,
  type DiscoveredService,
  type InstanceChangedBroadcast,
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
/** How often to scan known local ports for new MCP services. */
const DISCOVERY_SCAN_INTERVAL_MS = 30_000;
/** Timeout for probing a single port (tools/list). */
const PROBE_TIMEOUT_MS = 2_000;

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
  /** Resolved URL (for http/sse) — used to dedupe against discovered services. */
  url?: string;
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
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private localClients = new Map<string, MCPClientEntry>();
  /** Services found by port scan but not yet registered in DB. Keyed by fingerprint. */
  private discoveredServices = new Map<string, DiscoveredService>();
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

    // Start port scan for auto-discovery of local services
    this.startDiscoveryScan();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    console.log("[mcp-bridge] Stopping bridge...");

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
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
    let resolvedUrl: string | undefined;

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
        resolvedUrl = inst.url ?? preset?.default_local_url;
        if (!resolvedUrl) throw new Error(`No URL for instance ${inst.label}`);

        console.log(`[mcp-bridge] Connecting to ${transport} client: ${resolvedUrl}`);
        client = await createMCPClient({
          transport: { type: transport as "http" | "sse", url: resolvedUrl },
        });
      }

      const tools = await client.tools();
      const toolCount = Object.keys(tools).length;
      console.log(`[mcp-bridge] ✓ ${inst.label}: ${toolCount} tools`);

      this.localClients.set(inst.instanceId, {
        instanceId: inst.instanceId,
        label: inst.label,
        presetType: inst.presetType,
        url: resolvedUrl,
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
        url: resolvedUrl,
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

    // Listen for instance-changed events (webapp → hot-reload our client pool)
    this.devicesChannel.on(
      "broadcast",
      { event: INSTANCE_CHANGED_EVENT },
      ({ payload }: { payload: InstanceChangedBroadcast }) => {
        this.handleInstanceChanged(payload).catch((err) =>
          console.error("[mcp-bridge] handleInstanceChanged error:", err),
        );
      },
    );

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

  /**
   * React to a webapp-originated instance-changed broadcast.
   * Hot-adds or removes a client in the local pool, then publishes an
   * immediate heartbeat so the UI sees the new state right away.
   */
  private async handleInstanceChanged(payload: InstanceChangedBroadcast): Promise<void> {
    // Ignore events not addressed to this device
    if (payload.deviceId !== this.config.deviceId) return;

    console.log(`[mcp-bridge] instance-changed: ${payload.action}`, {
      instanceId: payload.instanceId ?? payload.instance?.instanceId,
      label: payload.instance?.label,
    });

    if (payload.action === "removed") {
      const id = payload.instanceId;
      if (!id) return;
      const entry = this.localClients.get(id);
      if (entry) {
        try { await entry.client?.close?.(); } catch { /* ignore */ }
        this.localClients.delete(id);
      }
    } else if (payload.action === "added" && payload.instance) {
      // Idempotent: if the instance is already in the pool (e.g. duplicate
      // broadcast, retry, or races with discovery scan), skip the re-create
      // to avoid leaking the previous client's socket/subprocess.
      if (this.localClients.has(payload.instance.instanceId)) {
        console.log(`[mcp-bridge] instance-changed: ${payload.instance.instanceId} already active, skipping re-add`);
      } else {
        await this.createLocalClient({
          instanceId: payload.instance.instanceId,
          label: payload.instance.label,
          presetType: payload.instance.presetType,
          url: payload.instance.url,
          transport: payload.instance.transport,
        });
      }
    } else if (payload.action === "toggled" && payload.instance) {
      const id = payload.instance.instanceId;
      if (payload.instance.enabled) {
        // Re-enabled: ensure the client exists
        if (!this.localClients.has(id)) {
          await this.createLocalClient({
            instanceId: id,
            label: payload.instance.label,
            presetType: payload.instance.presetType,
            url: payload.instance.url,
            transport: payload.instance.transport,
          });
        }
      } else {
        // Disabled: drop the client
        const entry = this.localClients.get(id);
        if (entry) {
          try { await entry.client?.close?.(); } catch { /* ignore */ }
          this.localClients.delete(id);
        }
      }
    }

    // Push a fresh heartbeat so the webapp UI reflects the change immediately.
    this.publishHeartbeat();
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

    // Filter out discovered services whose URL matches an already-active client.
    // (Otherwise a service shows up both as "active instance" AND "discovered".)
    const activeUrls = new Set<string>();
    for (const entry of this.localClients.values()) {
      if (entry.url) activeUrls.add(entry.url);
    }
    const discoveredList = Array.from(this.discoveredServices.values())
      .filter((d) => !activeUrls.has(d.url));

    const heartbeat: BridgeHeartbeat = {
      type: "bridge-hello",
      deviceId: this.config.deviceId,
      deviceName: hostname(),
      overlayVersion: process.env["npm_package_version"] ?? "unknown",
      osInfo: `${process.platform} ${process.arch}`,
      instances,
      discoveredServices: discoveredList.length > 0 ? discoveredList : undefined,
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

  // ── Discovery: scan known local ports for MCP services ───────────────────

  private startDiscoveryScan(): void {
    // Immediate first scan, then every 30s.
    this.runDiscoveryScan().catch((err) =>
      console.error("[mcp-bridge] initial discovery scan failed:", err),
    );
    this.discoveryTimer = setInterval(() => {
      if (!this.running) return;
      this.runDiscoveryScan().catch((err) =>
        console.error("[mcp-bridge] discovery scan failed:", err),
      );
    }, DISCOVERY_SCAN_INTERVAL_MS);
  }

  /**
   * Probe every known port from BUILTIN_PRESETS.scan_ports.
   * For each one that responds to tools/list, build a DiscoveredService entry.
   * The results replace this.discoveredServices (old entries that are no longer
   * responding disappear from the next heartbeat — the webapp UI will show them
   * as "offline" or remove them).
   */
  private async runDiscoveryScan(): Promise<void> {
    const next = new Map<string, DiscoveredService>();

    const probes: Array<Promise<void>> = [];
    for (const preset of Object.values(BUILTIN_PRESETS)) {
      if (preset.scope !== "local" || !preset.scan_ports) continue;
      if (preset.transport === "stdio") continue; // no port to probe

      const path = preset.scan_path ?? (preset.transport === "sse" ? "/sse" : "/mcp");
      const transportType = preset.transport as "http" | "sse";

      for (const port of preset.scan_ports) {
        const url = `http://127.0.0.1:${port}${path}`;
        probes.push(
          this.probeService(preset.preset_type, transportType, url)
            .then((found) => {
              if (found) next.set(found.fingerprint, found);
            })
            .catch(() => { /* port closed or not an MCP server */ }),
        );
      }
    }

    await Promise.allSettled(probes);
    this.discoveredServices = next;

    if (next.size > 0) {
      console.log(`[mcp-bridge] Discovery: ${next.size} service(s) on local ports`);
    }
  }

  /**
   * Probe a single URL with tools/list. Returns a DiscoveredService if it's a
   * functional MCP server, undefined otherwise. Bounded by PROBE_TIMEOUT_MS.
   */
  private async probeService(
    presetType: string,
    transport: "http" | "sse",
    url: string,
  ): Promise<DiscoveredService | undefined> {
    const fingerprint = `${presetType}:${url}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any = null;
    try {
      const clientPromise = createMCPClient({ transport: { type: transport, url } });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS),
      );
      client = await Promise.race([clientPromise, timeoutPromise]);

      const tools = await Promise.race([
        client.tools(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("tools/list timeout")), PROBE_TIMEOUT_MS),
        ),
      ]);

      const toolCount = Object.keys(tools as Record<string, unknown>).length;
      return { presetType, url, fingerprint, toolCount };
    } catch {
      return undefined;
    } finally {
      try { await client?.close?.(); } catch { /* ignore */ }
    }
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
