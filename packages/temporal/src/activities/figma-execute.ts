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
    let ackTimer: ReturnType<typeof setTimeout>;
    let resultTimer: ReturnType<typeof setTimeout>;

    function cleanup() {
      clearTimeout(ackTimer);
      clearTimeout(resultTimer);
      channel.unsubscribe();
    }

    function settle(result: ExecuteCodeResult) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    // Phase 1: Wait for ACK (plugin confirms it received the request)
    ackTimer = setTimeout(() => {
      if (!ackReceived && !settled) {
        log.warn(`no ack received within ${ACK_TIMEOUT_MS}ms — plugin offline?`, { req: requestId });
        settle({
          success: false,
          error: `No acknowledgement from plugin within ${ACK_TIMEOUT_MS / 1000}s. Make sure the Figma plugin is open with the Guardian webapp loaded.`,
        });
      }
    }, ACK_TIMEOUT_MS);

    // Phase 2 fallback: default result timeout (used if ack arrives without "awaiting_approval")
    resultTimer = setTimeout(() => {
      if (!settled) {
        log.warn(`execution timed out`, { req: requestId, timeout: defaultTimeoutMs, ackReceived });
        settle({ success: false, error: "Execution timed out" });
      }
    }, defaultTimeoutMs);

    channel
      // Listen for ACK from plugin
      .on("broadcast", { event: "execute_ack" }, (payload) => {
        const data = payload.payload;
        if (data?.requestId !== requestId || settled) return;

        ackReceived = true;
        clearTimeout(ackTimer);
        log.info(`ack received`, { req: requestId, status: data.status, from: data.senderClientId });

        // If plugin is awaiting user approval, extend the result timeout
        if (data.status === "awaiting_approval") {
          clearTimeout(resultTimer);
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
        const preview = typeof data.result === "string" ? data.result.slice(0, 100) : JSON.stringify(data.result ?? "").slice(0, 100);
        if (success) {
          log.info(`execution succeeded`, { req: requestId, result: preview });
        } else {
          log.warn(`execution failed`, { req: requestId, error: data.error ?? "unknown" });
        }
        settle({ success, result: data.result, error: data.error });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log.info(`channel subscribed, broadcasting`, { req: requestId });
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
          });
        } else {
          log.info(`channel status change`, { req: requestId, channelStatus: status });
        }
      });
  });
}
