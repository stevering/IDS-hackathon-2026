/**
 * Figma code execution activity.
 *
 * Sends code to the Figma plugin via Supabase Realtime (last-km transport)
 * and waits for the result.
 */

import { createClient } from "@supabase/supabase-js";
import type { ExecuteCodeParams, ExecuteCodeResult } from "@guardian/orchestrations";

export async function executeFigmaCode(params: ExecuteCodeParams): Promise<ExecuteCodeResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return { success: false, error: "Supabase credentials not configured" };
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const channel = supabase.channel(`guardian:execute:${params.userId}`);
  const requestId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const timeoutMs = params.timeoutMs ?? 30_000;

  return new Promise<ExecuteCodeResult>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ success: false, error: "Execution timed out" });
      }
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      channel.unsubscribe();
    }

    // Listen for result
    channel
      .on("broadcast", { event: "execute_result" }, (payload) => {
        const data = payload.payload;
        if (data?.requestId === requestId && !settled) {
          settled = true;
          cleanup();
          resolve({
            success: data.success ?? false,
            result: data.result,
            error: data.error,
          });
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          // Send the execution request
          channel.send({
            type: "broadcast",
            event: "execute_request",
            payload: {
              requestId,
              targetClientId: params.pluginClientId,
              code: params.code,
            },
          });
        }
      });
  });
}
