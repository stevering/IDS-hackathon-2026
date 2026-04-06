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

// ─── Timeout defaults ───────────────────────────────────────────────────────

/** Default timeout for a single bridge request (tools/list or tools/call). */
export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 15_000;

/** How long a heartbeat is considered "fresh" before the device is deemed offline. */
export const DEVICE_ONLINE_TTL_MS = 60_000;
