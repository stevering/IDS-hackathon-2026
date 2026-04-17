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
import WebSocket from "ws";
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
} from "@guardian/orchestrations/mcp";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BridgeConfig {
  userId: string;
  deviceId: string;
  deviceFingerprint: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** OAuth access_token — when set, Realtime and API calls are authenticated. */
  accessToken?: string;
  /** Supabase refresh_token — enables auto-refresh of access_token. */
  supabaseRefreshToken?: string;
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

// 5s so a freshly-mounted webapp hook (e.g. TargetSelector after navigating
// back) sees the device as online within ~5s instead of waiting up to 30s for
// the next broadcast. JSON over WS, cost is negligible.
const HEARTBEAT_INTERVAL_MS = 5_000;
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
  /** IDs removed while createLocalClient was still in-flight — prevents race condition. */
  private removedWhileConnecting = new Set<string>();
  /** Services found by port scan but not yet registered in DB. Keyed by fingerprint. */
  private discoveredServices = new Map<string, DiscoveredService>();
  private running = false;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.supabase = createSupabaseClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: !!config.supabaseRefreshToken },
      global: config.accessToken
        ? { headers: { Authorization: `Bearer ${config.accessToken}` } }
        : undefined,
      // Force the `ws` npm package for Realtime instead of relying on whatever
      // WebSocket global Electron's main process exposes. Observed: with the
      // Electron-provided WebSocket, `channel.subscribe()` consistently times
      // out when connecting to Supabase Realtime, even though an identical
      // supabase-js setup in a pure Node process succeeds. Using `ws` fixes it.
      realtime: {
        transport: WebSocket as unknown as typeof globalThis.WebSocket,
      },
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log(`[mcp-bridge] Starting bridge for user=${this.config.userId.slice(0, 8)} device=${this.config.deviceId.slice(0, 8)}`);

    // Set the session SYNCHRONOUSLY before any DB / Realtime call, so the
    // WS upgrade carries the user JWT. Without this, Realtime rejects the
    // connection (observed as `Channel subscription failed: TIMED_OUT`) and
    // inbound MCP requests from Temporal never reach the bridge.
    if (this.config.accessToken && this.config.supabaseRefreshToken) {
      try {
        await this.supabase.auth.setSession({
          access_token: this.config.accessToken,
          refresh_token: this.config.supabaseRefreshToken,
        });
        // Also explicitly tie Realtime to the JWT (required on some versions of
        // supabase-js where setSession does not automatically propagate).
        this.supabase.realtime.setAuth(this.config.accessToken);

        // CRITICAL for Electron main / Node: supabase-js's autoRefreshToken
        // relies on browser visibility events (document.visibilitychange) that
        // do NOT exist outside the browser. Without an explicit start, the
        // access_token expires after ~1h and every authenticated call (incl.
        // touch_device_last_seen, RLS reads) starts failing with
        // `JWT expired` until the app restarts. startAutoRefresh() polls every
        // ~10s and refreshes ahead of expiry using supabaseRefreshToken.
        await this.supabase.auth.startAutoRefresh();

        // Keep Realtime's auth in sync with each refresh, otherwise the WS
        // connection eventually drops with `auth_expired`.
        this.supabase.auth.onAuthStateChange((_event, session) => {
          if (session?.access_token) {
            this.supabase.realtime.setAuth(session.access_token);
          }
        });
      } catch (e) {
        console.error("[mcp-bridge] setSession failed:", e);
      }
    }

    // Fetch the user's local instances for THIS device from Supabase when we
    // have an authenticated session. This runs BEFORE initLocalClients so the
    // pool is populated at boot without depending on the Realtime broadcast
    // (which can time out if the WS channel isn't subscribed).
    if (this.config.accessToken) {
      try {
        await this.loadInstancesFromDb();
      } catch (err) {
        console.error("[mcp-bridge] loadInstancesFromDb failed:", err);
      }
    }

    console.log(`[mcp-bridge] ${this.config.instances.length} local instance(s) configured`);

    // Subscribe to the device-scoped MCP channel BEFORE spinning up local MCP
    // clients. initLocalClients keeps long-lived HTTP/SSE connections to
    // 127.0.0.1 servers (e.g. Figma on 3845) that can saturate Electron's
    // networking and cause the Supabase Realtime WS upgrade to time out if
    // opened afterwards. Subscribing first keeps the WS handshake on a clean
    // connection slot.
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

    this.mcpChannel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log(`[mcp-bridge] Subscribed to ${channelName}`);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        console.error(`[mcp-bridge] Channel subscription failed: ${status}`, err ? `err: ${err.message ?? err}` : "");
      } else {
        console.log(`[mcp-bridge] mcpChannel status: ${status}`);
      }
    });

    // Start heartbeat (subscribes to the devices channel too)
    this.startHeartbeat();

    // Now that both Realtime channels are set up, create the local MCP clients.
    await this.initLocalClients();

    // Start port scan for auto-discovery of local services
    this.startDiscoveryScan();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    console.log("[mcp-bridge] Stopping bridge...");

    // Stop the JWT auto-refresh polling (started in start() for Node/Electron).
    try {
      await this.supabase.auth.stopAutoRefresh();
    } catch { /* idempotent, may not have been started */ }

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

  // ── Load user's local instances from Supabase ─────────────────────────────
  // Reads user_mcp_instances filtered to this device + scope=local + enabled.
  // Replaces `this.config.instances` with what the DB says, so boot doesn't
  // depend on INSTANCE_CHANGED_EVENT broadcasts (which can miss if WS is down).
  private async loadInstancesFromDb(): Promise<void> {
    const { data, error } = await this.supabase
      .from("user_mcp_instances")
      .select("id, preset_type, label, config, scope, enabled, device_id")
      .eq("user_id", this.config.userId)
      .eq("device_id", this.config.deviceId)
      .eq("scope", "local")
      .eq("enabled", true);

    if (error) {
      console.error("[mcp-bridge] Failed to load instances from DB:", error.message);
      return;
    }

    const fetched: LocalInstanceConfig[] = (data ?? []).map((row) => {
      const cfg = row.config as { url?: string; transport?: string } | null;
      return {
        instanceId: row.id,
        label: row.label,
        presetType: row.preset_type,
        url: cfg?.url,
        transport: cfg?.transport as "http" | "sse" | undefined,
      };
    });

    console.log(`[mcp-bridge] Loaded ${fetched.length} instance(s) from DB for this device`);
    this.config.instances = fetched;
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

      // Guard: if the instance was removed while we were connecting, close immediately.
      if (this.removedWhileConnecting.has(inst.instanceId)) {
        console.log(`[mcp-bridge] ${inst.label} was removed while connecting — discarding`);
        this.removedWhileConnecting.delete(inst.instanceId);
        try { await client.close?.(); } catch { /* ignore */ }
        return;
      }

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

    this.devicesChannel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log(`[mcp-bridge] Heartbeat channel subscribed: ${channelName}`);
        this.publishHeartbeat(); // immediate first heartbeat
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        console.error(`[mcp-bridge] Heartbeat channel failed: ${status}`, err ? `err: ${err.message ?? err}` : "");
      } else {
        console.log(`[mcp-bridge] devicesChannel status: ${status}`);
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
      // Mark as removed so in-flight createLocalClient won't re-add it.
      this.removedWhileConnecting.add(id);
      const entry = this.localClients.get(id);
      if (entry) {
        try { await entry.client?.close?.(); } catch { /* ignore */ }
        this.localClients.delete(id);
      }
    } else if (payload.action === "added" && payload.instance) {
      // Clear any prior removal guard — the user re-enabled or re-added this instance.
      this.removedWhileConnecting.delete(payload.instance.instanceId);
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

  /**
   * Update user_devices.last_seen_at in the DB so the webapp's REST endpoints
   * (`/api/user/mcp-instances`, `/api/user/devices`) report the device as online.
   * Fire-and-forget; failures are non-fatal. Runs on every heartbeat tick.
   */
  private touchLastSeen(): void {
    if (!this.config.accessToken) return; // env-var mode has no session
    this.supabase
      .rpc("touch_device_last_seen", { p_device_fingerprint: this.config.deviceFingerprint })
      .then(({ error }) => {
        if (error) console.error("[mcp-bridge] touch_device_last_seen failed:", error.message);
      });
  }

  private publishHeartbeat(): void {
    // Keep the DB's last_seen_at fresh so REST-driven UIs (TargetSelector,
    // Local services) show the device as online without waiting for a live
    // Realtime broadcast.
    this.touchLastSeen();

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
    const attempts: Array<{ url: string; ok: boolean; error?: string }> = [];

    // For each port, try Streamable HTTP first (/mcp), then SSE (/sse).
    // HTTP is preferred (newer, more features). If HTTP responds, skip SSE.
    // Fingerprint is keyed by preset+port so HTTP wins over SSE for the same port.
    const portProbes: Array<Promise<void>> = [];
    for (const preset of Object.values(BUILTIN_PRESETS)) {
      if (preset.scope !== "local" || !preset.scan_ports) continue;
      if (preset.transport === "stdio") continue; // no port to probe

      for (const port of preset.scan_ports) {
        // Priority order: http (/mcp) → sse (/sse)
        const candidates: Array<{ transport: "http" | "sse"; url: string }> = [
          { transport: "http", url: `http://127.0.0.1:${port}/mcp` },
          { transport: "sse",  url: `http://127.0.0.1:${port}/sse` },
        ];
        const fingerprint = `${preset.preset_type}:127.0.0.1:${port}`;

        portProbes.push(
          (async () => {
            for (const { transport, url } of candidates) {
              try {
                const found = await this.probeService(preset.preset_type, transport, url);
                if (found) {
                  // Override fingerprint so both transports map to the same port key
                  found.fingerprint = fingerprint;
                  next.set(fingerprint, found);
                  attempts.push({ url: `${url} (${transport})`, ok: true });
                  return; // HTTP succeeded → skip SSE
                }
                attempts.push({ url: `${url} (${transport})`, ok: false, error: "probe returned undefined" });
              } catch (e) {
                attempts.push({ url: `${url} (${transport})`, ok: false, error: String((e as Error)?.message ?? e) });
              }
            }
          })(),
        );
      }
    }

    await Promise.allSettled(portProbes);
    this.discoveredServices = next;

    const summary = `${next.size}/${attempts.length} services found`;
    if (next.size > 0) {
      console.log(`[mcp-bridge] Discovery: ${summary}`);
    } else {
      // Print once per scan so you can see WHY nothing was discovered.
      console.log(`[mcp-bridge] Discovery: ${summary}. Attempts:`);
      for (const a of attempts) {
        console.log(`  ${a.ok ? "✓" : "✗"} ${a.url}${a.error ? " — " + a.error : ""}`);
      }
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
      const serverName = (client.serverInfo as { name?: string; title?: string })?.title
        ?? (client.serverInfo as { name?: string })?.name
        ?? undefined;
      return { presetType, url, transport, fingerprint, toolCount, serverName };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[mcp-bridge] probe ${url} failed: ${msg}`);
      // Re-throw so the scan loop's error bucket surfaces the real reason
      // (connection refused, 404, wrong transport, timeout, etc.).
      throw new Error(msg);
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
