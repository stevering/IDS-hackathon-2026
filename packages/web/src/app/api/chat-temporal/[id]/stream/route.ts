/**
 * GET /api/chat-temporal/[id]/stream
 *
 * SSE endpoint that subscribes to the Supabase Realtime channel
 * for a chat workflow and relays streaming events to the browser.
 *
 * Events relayed: text_delta, reasoning_delta, tool_call_start, text_complete
 */

import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createLogger } from "@/lib/log";

export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 15_000;
const WORKFLOW_POLL_MS = 5_000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workflowId } = await params;

  if (process.env.TEMPORAL_ENABLED !== "true") {
    return new Response("Temporal chat is not enabled", { status: 503 });
  }

  // Auth
  const supabase = await createSupabaseUserClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const log = createLogger("chat-temporal/stream", { u: user.id.slice(0, 8), wf: workflowId });

  // Extract conversationId from workflowId or query param
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) {
    return new Response("Missing conversationId query param", { status: 400 });
  }

  // ── Ownership check ─────────────────────────────────────────────────────
  // The Supabase Realtime broadcast channel `guardian:chat:<conversationId>`
  // carries token deltas, tool calls, and reasoning for the in-flight chat.
  // Without an explicit ownership verification, any authenticated user could
  // pass another user's conversationId and eavesdrop on their streaming
  // response. RLS policies do NOT protect Realtime broadcast channels — only
  // table reads — so we must verify ownership here before subscribing.
  //
  // Service role client: the user-authenticated client is also fine under
  // RLS, but using the service role makes the check explicit and robust to
  // future conversations.select RLS changes.
  {
    const svc = createServiceClient();
    const { data: conv, error: convErr } = await svc
      .from("conversations")
      .select("user_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (convErr || !conv) {
      log.warn("conversation not found for stream", { conv: conversationId });
      return new Response("Not found", { status: 404 });
    }
    if (conv.user_id !== user.id) {
      log.warn("cross-user stream subscribe attempt blocked", { conv: conversationId, owner: String(conv.user_id).slice(0, 8) });
      return new Response("Forbidden", { status: 403 });
    }
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      function send(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      }

      // Subscribe to Realtime channel for streaming events.
      // `stream_error` is broadcast by `callLLMStreaming` on LLM API errors
      // (e.g. 401 from provider, rate limit, invalid model). `workflow_error`
      // is sent by the poller below when the workflow itself fails (worker
      // crash, activity failure, non-retryable exception) so the client can
      // distinguish "stream failed" from "workflow crashed" and show the
      // appropriate error message instead of hanging on workflow_completed.
      const sb = createServiceClient();
      const channelName = `guardian:chat:${conversationId}`;
      const channel = sb.channel(channelName);

      const STREAM_EVENTS = [
        "text_delta",
        "reasoning_delta",
        "tool_call_start",
        "tool_call_result",
        "text_complete",
        "stream_error",
      ];

      for (const eventName of STREAM_EVENTS) {
        channel.on("broadcast", { event: eventName }, (payload) => {
          send(eventName, payload.payload);
        });
      }

      await new Promise<void>((resolve) => {
        channel.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            log.info("subscribed to chat stream", { channel: channelName });
            send("connected", { workflowId, conversationId });
            resolve();
          }
        });
        setTimeout(resolve, 3000); // Fallback
      });

      // Periodically check if workflow is still running.
      //
      // Terminal states are split by outcome so the client can route:
      //   - COMPLETED                    → normal end, wait for text_complete
      //   - CANCELLED                    → user clicked Stop, text_complete
      //                                    carries finishReason="cancelled"
      //   - FAILED / TERMINATED / TIMED_OUT → workflow crashed; emit
      //                                    `workflow_error` with reason so the
      //                                    client stops waiting and surfaces
      //                                    the failure instead of polling
      //                                    forever on workflow_completed.
      const workflowPoller = setInterval(async () => {
        try {
          const { getTemporalClient } = await import("@guardian/temporal/client");
          const client = await getTemporalClient();
          const handle = client.workflow.getHandle(workflowId);
          const desc = await handle.describe();
          const statusName = desc.status.name;

          if (statusName === "FAILED" || statusName === "TERMINATED" || statusName === "TIMED_OUT") {
            // Try to extract a human-readable failure reason from the
            // workflow history. handle.result() throws with the root cause
            // for failed workflows, so we use that to surface a message.
            let reason: string = statusName;
            try {
              await handle.result();
            } catch (resultErr) {
              reason = resultErr instanceof Error ? resultErr.message : String(resultErr);
            }
            log.warn("workflow ended abnormally", { status: statusName, reason });
            send("workflow_error", { status: statusName, error: reason });
            cleanup();
            return;
          }

          if (statusName === "COMPLETED" || statusName === "CANCELLED") {
            send("workflow_completed", { status: statusName });
            cleanup();
          }
        } catch (pollErr) {
          // Workflow not found or describe() error — treat as an error we
          // can't diagnose, but tell the client to stop waiting.
          log.warn("workflow poll failed", { error: String(pollErr) });
          send("workflow_error", { status: "UNKNOWN", error: pollErr instanceof Error ? pollErr.message : String(pollErr) });
          cleanup();
        }
      }, WORKFLOW_POLL_MS);

      // Keepalive pings
      const keepaliveTimer = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            closed = true;
          }
        }
      }, KEEPALIVE_MS);

      // Cleanup on abort
      request.signal.addEventListener("abort", () => cleanup());

      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(workflowPoller);
        clearInterval(keepaliveTimer);
        channel.unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
