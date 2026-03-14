/**
 * Figma code execution activity.
 *
 * Sends code to the Figma plugin via Supabase Realtime (last-km transport)
 * and waits for the result.
 */

import { createClient } from "@supabase/supabase-js";
import type { ExecuteCodeParams, ExecuteCodeResult } from "@guardian/orchestrations";
import { createLogger } from "../lib/log.js";

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
  const timeoutMs = params.timeoutMs ?? 30_000;

  log.info(`sending execute_request`, { req: requestId, timeout: timeoutMs, codeLen: params.code.length });

  return new Promise<ExecuteCodeResult>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        log.warn(`execution timed out`, { req: requestId, timeout: timeoutMs });
        resolve({ success: false, error: "Execution timed out" });
      }
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      channel.unsubscribe();
    }

    channel
      .on("broadcast", { event: "execute_result" }, (payload) => {
        const data = payload.payload;
        if (data?.requestId === requestId && !settled) {
          settled = true;
          cleanup();
          const success = data.success ?? false;
          const preview = typeof data.result === "string" ? data.result.slice(0, 100) : JSON.stringify(data.result ?? "").slice(0, 100);
          if (success) {
            log.info(`execution succeeded`, { req: requestId, result: preview });
          } else {
            log.warn(`execution failed`, { req: requestId, error: data.error ?? "unknown" });
          }
          resolve({ success, result: data.result, error: data.error });
        }
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
              ...(params.workflowId ? { workflowId: params.workflowId } : {}),
            },
          });
        } else {
          log.info(`channel status change`, { req: requestId, channelStatus: status });
        }
      });
  });
}
