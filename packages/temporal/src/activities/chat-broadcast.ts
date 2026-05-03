/**
 * Broadcast chat events to the browser via Supabase Realtime.
 *
 * Used by chatWorkflow to notify the browser about tool execution
 * progress (tool_call_start, tool_call_result) since these happen
 * outside of the callLLMStreaming activity.
 */

import { createClient } from "@supabase/supabase-js";
import { createLogger } from "../lib/log.js";
import { redactPayload } from "../lib/redact.js";

export async function broadcastChatEvent(params: {
  conversationId: string;
  event: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const log = createLogger("chat-broadcast", {
    conv: params.conversationId.slice(0, 8),
    event: params.event,
  });
  log.info("broadcasting", redactPayload(params.payload));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    log.warn("no Supabase credentials");
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const channel = supabase.channel(`guardian:chat:${params.conversationId}`);

  await new Promise<void>((resolve) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        channel.send({
          type: "broadcast",
          event: params.event,
          payload: params.payload,
        }).then(() => {
          channel.unsubscribe();
          resolve();
        });
      } else {
        setTimeout(resolve, 2000); // Fallback
      }
    });
  });
}
