/**
 * GET /api/orchestration/[id]/stream
 *
 * SSE endpoint that polls the Temporal workflow query and streams
 * orchestration events to the browser.
 */

import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";
import type { OrchestrationStatusResponse } from "@guardian/orchestrations";
import { createLogger } from "@/lib/log";

export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 1_000;
const KEEPALIVE_MS = 15_000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workflowId } = await params;

  if (process.env.TEMPORAL_ENABLED !== "true") {
    return new Response("Temporal orchestration is not enabled", { status: 503 });
  }

  const supabase = await createSupabaseUserClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const log = createLogger("orch/stream", { u: user.id.slice(0, 8), wf: workflowId });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      // Handle client disconnect
      request.signal.addEventListener("abort", () => {
        closed = true;
        log.info("client disconnected");
      });

      try {
        const { getTemporalClient, statusQuery } = await import("@guardian/temporal/client");
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(workflowId);

        log.info("SSE connected");
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "connected", workflowId })}\n\n`)
        );

        let lastKeepalive = Date.now();
        let pollCount = 0;
        let lastCursor = 0;

        while (!closed) {
          try {
            const status: OrchestrationStatusResponse = await handle.query(statusQuery, lastCursor);

            pollCount++;
            lastCursor = status.eventCursor;

            // Stream new events
            if (status.events.length > 0) {
              log.info(`${status.events.length} new events`, {
                poll: pollCount,
                types: status.events.map((e: { type: string }) => e.type).join(","),
              });
            }
            for (const event of status.events) {
              if (closed) break;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
              );
            }

            // Send timer tick
            if (status.timerRemainingMs !== null) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "timer_tick",
                    remainingMs: status.timerRemainingMs,
                    totalMs: status.totalDurationMs,
                  })}\n\n`
                )
              );
            }

            // Check if orchestration is done
            if (status.status !== "active") {
              log.info(`orchestration ended`, { status: status.status, polls: pollCount });
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "orchestration_completed",
                    status: status.status,
                  })}\n\n`
                )
              );
              break;
            }
          } catch (queryError) {
            // Workflow may have completed — check if it's a "not found" type error
            const msg = String(queryError);
            if (msg.includes("not found") || msg.includes("completed")) {
              log.info("workflow gone, treating as completed", { polls: pollCount });
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "orchestration_completed",
                    status: "completed",
                  })}\n\n`
                )
              );
              break;
            }

            // Send keepalive on transient errors
            if (Date.now() - lastKeepalive > KEEPALIVE_MS) {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              lastKeepalive = Date.now();
            }
          }

          // Wait before next poll
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      } catch (err) {
        log.error(`stream error: ${err}`);
        if (!closed) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", message: String(err) })}\n\n`
            )
          );
        }
      } finally {
        if (!closed) {
          controller.close();
        }
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
