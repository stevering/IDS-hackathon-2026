/**
 * Figma code execution activity.
 *
 * Sends code to the Figma plugin via Supabase Realtime (last-km transport)
 * and waits for the result.
 *
 * Three-phase protocol:
 *   1. REQUEST  — activity broadcasts `execute_request` to plugin
 *   2. ACK      — plugin immediately replies `execute_ack` (received / awaiting_approval)
 *   3. RESULT   — plugin broadcasts `execute_result` after code runs
 *
 * If no ACK within ACK_TIMEOUT_MS, the plugin is considered offline → timeout error.
 * If ACK received with "awaiting_approval", the result timeout extends to APPROVAL_TIMEOUT_MS.
 */

import { createClient } from "@supabase/supabase-js";
import type { ExecuteCodeParams, ExecuteCodeResult } from "@guardian/orchestrations";
import { createLogger } from "../lib/log.js";

const ACK_TIMEOUT_MS = 10_000;      // 10s to receive an ack from the plugin
const APPROVAL_TIMEOUT_MS = 120_000; // 2min if user needs to approve

export async function executeFigmaCode(params: ExecuteCodeParams): Promise<ExecuteCodeResult> {
  const log = createLogger("figma-exec", {
    u: params.userId.slice(0, 8),
    c: params.pluginClientId,
    wf: params.workflowId ?? "-",
  });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    log.error("Supabase credentials not configured");
    return { success: false, error: "Supabase credentials not configured" };
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const channel = supabase.channel(`guardian:execute:${params.userId}`);
  const requestId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const defaultTimeoutMs = params.timeoutMs ?? 30_000;

  log.info(`sending execute_request`, { req: requestId, timeout: defaultTimeoutMs, codeLen: params.code.length });

  return new Promise<ExecuteCodeResult>((resolve) => {
    let settled = false;
    let ackReceived = false;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    let resultTimer: ReturnType<typeof setTimeout> | undefined;
    let subscribeGuardTimer: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
      if (ackTimer) clearTimeout(ackTimer);
      if (resultTimer) clearTimeout(resultTimer);
      if (subscribeGuardTimer) clearTimeout(subscribeGuardTimer);
      channel.unsubscribe();
    }

    function settle(result: ExecuteCodeResult) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    // Register event handlers BEFORE calling subscribe() — the fluent chain
    // below guarantees .on() runs synchronously before .subscribe() initiates
    // the WebSocket connection, so no response event can slip past the
    // handler registration.
    //
    // The ACK and result timers are NOT started here. They only start once
    // we receive a SUBSCRIBED status confirmation — otherwise a subscription
    // failure (CHANNEL_ERROR / TIMED_OUT / CLOSED) would still let the 10s
    // ACK timer fire with the misleading "plugin offline" error when the
    // real problem is that we never had a channel to the plugin in the
    // first place.
    channel
      // Listen for ACK from plugin
      .on("broadcast", { event: "execute_ack" }, (payload) => {
        const data = payload.payload;
        if (data?.requestId !== requestId || settled) return;

        ackReceived = true;
        if (ackTimer) clearTimeout(ackTimer);
        log.info(`ack received`, { req: requestId, status: data.status, from: data.senderClientId });

        // If plugin is awaiting user approval, extend the result timeout
        if (data.status === "awaiting_approval") {
          if (resultTimer) clearTimeout(resultTimer);
          resultTimer = setTimeout(() => {
            if (!settled) {
              log.warn(`approval timed out`, { req: requestId, timeout: APPROVAL_TIMEOUT_MS });
              settle({ success: false, error: `User did not approve within ${APPROVAL_TIMEOUT_MS / 1000}s` });
            }
          }, APPROVAL_TIMEOUT_MS);
          log.info(`extended timeout to ${APPROVAL_TIMEOUT_MS}ms for approval`, { req: requestId });
        }
      })
      // Listen for final RESULT from plugin
      .on("broadcast", { event: "execute_result" }, (payload) => {
        const data = payload.payload;
        if (data?.requestId !== requestId || settled) return;

        const success = data.success ?? false;
        const resultLen = typeof data.result === "string"
          ? data.result.length
          : (data.result === undefined ? 0 : JSON.stringify(data.result).length);
        if (success) {
          log.info(`execution succeeded`, { req: requestId, resultLen });
        } else {
          log.warn(`execution failed`, { req: requestId, errType: typeof data.error });
        }
        settle({ success, result: data.result, error: data.error });
      })
      .subscribe((status) => {
        if (settled) return;

        if (status === "SUBSCRIBED") {
          log.info(`channel subscribed, broadcasting`, { req: requestId });

          // Subscription confirmed — NOW start the protocol timers. Broadcast
          // the execute_request, then arm the ACK timer (plugin offline) and
          // the result timer (execution timed out).
          channel.send({
            type: "broadcast",
            event: "execute_request",
            payload: {
              requestId,
              targetClientId: params.pluginClientId,
              code: params.code,
              timeout: Math.max(defaultTimeoutMs - 5000, 5000),
              ...(params.workflowId ? { workflowId: params.workflowId } : {}),
            },
          }).catch((broadcastErr) => {
            log.error(`execute_request broadcast failed`, { req: requestId, error: String(broadcastErr) });
            settle({ success: false, error: `Failed to broadcast execute request: ${broadcastErr}` });
          });

          ackTimer = setTimeout(() => {
            if (!ackReceived && !settled) {
              log.warn(`no ack received within ${ACK_TIMEOUT_MS}ms — plugin offline?`, { req: requestId });
              settle({
                success: false,
                error: `No acknowledgement from plugin within ${ACK_TIMEOUT_MS / 1000}s. Make sure the Figma plugin is open with the Guardian webapp loaded.`,
              });
            }
          }, ACK_TIMEOUT_MS);

          resultTimer = setTimeout(() => {
            if (!settled) {
              log.warn(`execution timed out`, { req: requestId, timeout: defaultTimeoutMs, ackReceived });
              settle({ success: false, error: "Execution timed out" });
            }
          }, defaultTimeoutMs);

          // Clear the initial subscribe guard now that we're connected
          if (subscribeGuardTimer) {
            clearTimeout(subscribeGuardTimer);
            subscribeGuardTimer = undefined;
          }
          return;
        }

        // Explicit failure statuses — distinct error from "plugin offline"
        // so operators can tell "we never reached Supabase Realtime" apart
        // from "the plugin itself never answered".
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          log.error(`channel subscribe failed`, { req: requestId, channelStatus: status });
          settle({
            success: false,
            error: `Failed to establish Realtime channel (status=${status}). This is a transport error, not a plugin offline condition — check Supabase Realtime health.`,
          });
          return;
        }

        // Intermediate statuses (e.g. CONNECTING) — just log
        log.info(`channel status change`, { req: requestId, channelStatus: status });
      });

    // Guard against the case where subscribe() never calls its callback at
    // all (network blackhole). Without this, the promise would never resolve
    // and Temporal would only bail at the 3-minute activity startToClose
    // timeout with no useful error.
    subscribeGuardTimer = setTimeout(() => {
      if (!settled) {
        log.error(`channel subscribe never reported status`, { req: requestId, waited: ACK_TIMEOUT_MS });
        settle({
          success: false,
          error: `Realtime channel subscribe callback never fired within ${ACK_TIMEOUT_MS / 1000}s. Transport layer stalled.`,
        });
      }
    }, ACK_TIMEOUT_MS);
  });
}
