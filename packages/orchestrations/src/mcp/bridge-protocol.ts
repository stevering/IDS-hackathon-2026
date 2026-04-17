/**
 * Guardian Bridge protocol — message types exchanged over Supabase Realtime
 * between the Temporal worker (cloud) and the Electron overlay (user machine).
 *
 * Channels:
 *   guardian:mcp:${userId}:${deviceId}   — per-device RPC channel
 *     events: 'mcp-request', 'mcp-response'
 *   guardian:devices:${userId}           — user-wide device presence channel
 *     events: 'bridge-hello'
 *
 * Pure TypeScript types, no runtime dependencies.
 */

// ─── Channel name helpers ───────────────────────────────────────────────────

export function mcpChannelName(userId: string, deviceId: string): string {
  return `guardian:mcp:${userId}:${deviceId}`;
}

export function devicesChannelName(userId: string): string {
  return `guardian:devices:${userId}`;
}

// ─── Events ─────────────────────────────────────────────────────────────────

export const MCP_REQUEST_EVENT = "mcp-request" as const;
export const MCP_RESPONSE_EVENT = "mcp-response" as const;
export const BRIDGE_HELLO_EVENT = "bridge-hello" as const;
/** Broadcast from the webapp to all user companions when a local instance is added/removed/toggled. */
export const INSTANCE_CHANGED_EVENT = "instance-changed" as const;

// ─── Request / Response (worker ↔ overlay) ──────────────────────────────────

/**
 * Published by the worker on guardian:mcp:${userId}:${deviceId}.
 * The overlay for that device handles it, all others ignore.
 */
export type MCPBridgeRequest = {
  type: "mcp-request";
  requestId: string;
  /**
   * Target device id — redundant with the channel name but kept in the payload
   * as a safety filter. The overlay must drop requests where this doesn't
   * match its own deviceId.
   */
  targetDeviceId: string;
  /** user_mcp_instances.id — overlay looks this up in its local client pool. */
  instanceId: string;
  method: "tools/list" | "tools/call";
  params?: {
    /** Raw tool name, without the `<slug>_<label>_` prefix. */
    name: string;
    arguments: Record<string, unknown>;
  };
  /** Absolute epoch ms after which the overlay should stop processing. */
  deadline: number;
};

/**
 * Published by the overlay on the same channel, correlated by requestId.
 */
export type MCPBridgeResponse = {
  type: "mcp-response";
  requestId: string;
  ok: boolean;
  /** Tool execution result or the MCP tools array (when method='tools/list'). */
  result?: unknown;
  /** Human-readable error message when ok=false. */
  error?: string;
};

// ─── Heartbeat (overlay → user-wide) ────────────────────────────────────────

/**
 * Published by the overlay on guardian:devices:${userId} every ~30 s and on
 * state changes (instance goes online/offline, subprocess crashes, ...).
 * The webapp Account page subscribes to render a live bridge status.
 */
export type BridgeHeartbeat = {
  type: "bridge-hello";
  deviceId: string;
  deviceName: string;
  overlayVersion: string;
  osInfo: string;
  /** Per-instance status snapshot at the moment of publishing. */
  instances: BridgeHeartbeatInstance[];
  /**
   * Services detected by port scanning that are NOT yet registered as
   * user_mcp_instances (i.e. the user hasn't clicked Enable or Ignore yet).
   * The webapp shows these under "DISCOVERED" in the Local services section.
   */
  discoveredServices?: DiscoveredService[];
  /** epoch ms at publish time, used for staleness detection. */
  publishedAt: number;
};

export type BridgeHeartbeatInstance = {
  instanceId: string;
  label: string;
  presetType: string;
  online: boolean;
  toolCount?: number;
  error?: string;
};

/**
 * A service found by port scanning but not yet registered in the DB.
 * The webapp receives these via the heartbeat and offers [Enable] / [Ignore]
 * buttons. Once the user clicks Enable, a row is created in user_mcp_instances
 * and the service moves from `discoveredServices` → `instances` in subsequent
 * heartbeats.
 */
export type DiscoveredService = {
  /** Matches a preset_type in BUILTIN_PRESETS. */
  presetType: string;
  /** URL where the service was found (e.g. "http://127.0.0.1:3845/mcp"). */
  url: string;
  /** Transport that successfully connected ("http" or "sse"). */
  transport: "http" | "sse";
  /** Stable fingerprint for dedupe across heartbeats — `${presetType}:${url}`. */
  fingerprint: string;
  /** Number of tools exposed (from a tools/list probe). */
  toolCount: number;
  /** Server name if the MCP server reports one (optional). */
  serverName?: string;
};

// ─── Instance change broadcast (webapp → companions) ────────────────────────

/**
 * Published by the webapp on guardian:devices:${userId} whenever a local
 * instance is created / updated / removed. The companion with matching
 * deviceId reacts by hot-adding/removing the client — no restart needed.
 *
 * Only local-scope instances trigger this broadcast. Cloud instances don't
 * need it (they're consumed server-side by the Temporal worker).
 */
export type InstanceChangedBroadcast = {
  type: "instance-changed";
  /** Target deviceId — companions ignore events for other devices. */
  deviceId: string;
  action: "added" | "removed" | "toggled";
  /**
   * Full instance descriptor for "added" and "toggled" (when enabled=true).
   * For "removed" or "toggled" (enabled=false), only `instanceId` is needed.
   */
  instance?: {
    instanceId: string;
    label: string;
    presetType: string;
    url?: string;
    transport?: "http" | "sse" | "stdio";
    enabled: boolean;
  };
  /** For "removed" and for "toggled"→disabled: which instance to drop. */
  instanceId?: string;
};

// ─── Timeout defaults ───────────────────────────────────────────────────────

/** Default timeout for a single bridge request (tools/list or tools/call). */
export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 15_000;

/** How long a heartbeat is considered "fresh" before the device is deemed offline. */
export const DEVICE_ONLINE_TTL_MS = 60_000;
