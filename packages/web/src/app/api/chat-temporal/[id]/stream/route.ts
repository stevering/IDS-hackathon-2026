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

      // Subscribe to Realtime channel for streaming events
      const sb = createServiceClient();
      const channelName = `guardian:chat:${conversationId}`;
      const channel = sb.channel(channelName);

      const STREAM_EVENTS = ["text_delta", "reasoning_delta", "tool_call_start", "tool_call_result", "text_complete"];

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

      // Periodically check if workflow is still running
      const workflowPoller = setInterval(async () => {
        try {
          const { getTemporalClient } = await import("@guardian/temporal/client");
          const client = await getTemporalClient();
          const handle = client.workflow.getHandle(workflowId);
          const desc = await handle.describe();
          if (desc.status.name === "COMPLETED" || desc.status.name === "FAILED" || desc.status.name === "CANCELLED") {
            send("workflow_completed", { status: desc.status.name });
            cleanup();
          }
        } catch {
          // Workflow not found or error — send completion
          send("workflow_completed", { status: "UNKNOWN" });
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
