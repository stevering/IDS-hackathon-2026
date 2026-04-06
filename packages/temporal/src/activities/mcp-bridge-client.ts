/**
 * Guardian Bridge client — publishes MCP requests on Supabase Realtime
 * and awaits responses from the user's Electron overlay.
 *
 * Used by discoverMCPTools / executeMCPTool (Phase 5) for local MCPs
 * whose transport is 'bridged'.
 *
 * The overlay on the user's device subscribes to the same channel,
 * forwards calls to the local MCP server, and publishes the response.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  mcpChannelName,
  MCP_REQUEST_EVENT,
  MCP_RESPONSE_EVENT,
  DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS,
  type MCPBridgeRequest,
  type MCPBridgeResponse,
} from "@guardian/orchestrations";
import { createLogger } from "../lib/log.js";

const log = createLogger("mcp-bridge");

// ---------------------------------------------------------------------------
// Supabase Realtime client (anon key — service-role is rejected by Realtime)
// ---------------------------------------------------------------------------

function createRealtimeClient(): SupabaseClient {
  const anonKey =
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY ??
    process.env.STORAGE_SUPABASE_ANON_KEY;
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.STORAGE_SUPABASE_URL ??
    "";
  if (!supabaseUrl || !anonKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_ANON_KEY for Realtime bridge",
    );
  }
  return createClient(supabaseUrl, anonKey);
}

// ---------------------------------------------------------------------------
// callBridgedMCP — request / response over Supabase Realtime
// ---------------------------------------------------------------------------

export type BridgedMCPResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export type CallBridgedMCPParams = {
  userId: string;
  deviceId: string;
  instanceId: string;
  method: "tools/list" | "tools/call";
  params?: { name: string; arguments: Record<string, unknown> };
  timeoutMs?: number;
  /** Inject a Supabase client (for testing). */
  _supabaseClient?: SupabaseClient;
};

/**
 * Send a single MCP request to a user's overlay device and await the response.
 *
 * Creates an ephemeral Supabase Realtime channel scoped to the device,
 * publishes a `mcp-request` event, and resolves when the overlay publishes
 * a correlated `mcp-response` event (or rejects on timeout).
 */
export async function callBridgedMCP(
  p: CallBridgedMCPParams,
): Promise<BridgedMCPResult> {
  const timeout = p.timeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS;
  const requestId = randomUUID();
  const channelName = mcpChannelName(p.userId, p.deviceId);

  const request: MCPBridgeRequest = {
    type: "mcp-request",
    requestId,
    targetDeviceId: p.deviceId,
    instanceId: p.instanceId,
    method: p.method,
    params: p.params,
    deadline: Date.now() + timeout,
  };

  log.info(`Bridge request → ${channelName}`, {
    requestId: requestId.slice(0, 8),
    instance: p.instanceId.slice(0, 8),
    method: p.method,
    tool: p.params?.name,
  });

  const client = p._supabaseClient ?? createRealtimeClient();
  const ch = client.channel(channelName);

  try {
    return await new Promise<BridgedMCPResult>((resolve) => {
      let settled = false;

      const settle = (result: BridgedMCPResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ch.unsubscribe();
        resolve(result);
      };

      // Timeout guard
      const timer = setTimeout(() => {
        log.warn(`Bridge timeout (${timeout}ms) for device ${p.deviceId.slice(0, 8)}`);
        settle({
          ok: false,
          error: `Bridge timeout after ${timeout}ms — device may be offline. Start the Guardian overlay on that machine.`,
        });
      }, timeout);

      // Listen for correlated response BEFORE subscribing
      ch.on(
        "broadcast",
        { event: MCP_RESPONSE_EVENT },
        ({ payload }: { payload: MCPBridgeResponse }) => {
          if (payload.requestId !== requestId) return;

          if (payload.ok) {
            log.info(`Bridge response ← OK`, {
              requestId: requestId.slice(0, 8),
            });
            settle({ ok: true, result: payload.result });
          } else {
            log.warn(`Bridge response ← ERROR: ${payload.error}`, {
              requestId: requestId.slice(0, 8),
            });
            settle({ ok: false, error: payload.error ?? "Unknown bridge error" });
          }
        },
      );

      // Subscribe then publish the request
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          ch.send({
            type: "broadcast",
            event: MCP_REQUEST_EVENT,
            payload: request,
          });
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          settle({
            ok: false,
            error: `Failed to subscribe to bridge channel: ${status}`,
          });
        }
      });
    });
  } catch (err) {
    log.error(`callBridgedMCP unexpected error`, { error: String(err) });
    return { ok: false, error: String(err) };
  }
}
