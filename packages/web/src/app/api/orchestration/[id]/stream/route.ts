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

  // Resolve user identity: MCP service-key (internal) OR Supabase session (browser)
  let userId: string;
  // Supabase client — needed later to replay persisted events from the database
  const supabase = await createSupabaseUserClient();

  const mcpServiceKey = request.headers.get("x-mcp-service-key");
  const mcpUserId = request.headers.get("x-mcp-user-id");
  const expectedKey = process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  if (mcpServiceKey && mcpUserId && expectedKey && mcpServiceKey === expectedKey) {
    userId = mcpUserId;
  } else {
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    userId = user.id;
  }

  const log = createLogger("orch/stream", { u: userId.slice(0, 8), wf: workflowId });

  const encoder = new TextEncoder();

  // ── Helper: replay persisted events from Supabase ─────────────────────
  async function replayFromDb(
    controller: ReadableStreamDefaultController,
    closed: { value: boolean },
  ) {
    const { data: persistedEvents } = await supabase
      .from("orchestration_events")
      .select("payload")
      .eq("workflow_id", workflowId)
      .order("created_at", { ascending: true });

    if (persistedEvents && persistedEvents.length > 0) {
      const replayable = persistedEvents.filter(
        (row) => (row.payload as { type?: string })?.type !== "orchestration_completed"
      );
      log.info(`replaying ${replayable.length} persisted events from DB (${persistedEvents.length} total)`);
      for (const row of replayable) {
        if (closed.value) break;
        const payload = { ...(row.payload as Record<string, unknown>), _replayed: true };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
    }

    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ type: "orchestration_completed", status: "completed" })}\n\n`
      )
    );
  }

  // ── Check if orchestration is already completed in DB ─────────────────
  const { count: completedCount } = await supabase
    .from("orchestration_events")
    .select("id", { count: "exact", head: true })
    .eq("workflow_id", workflowId)
    .eq("payload->>type", "orchestration_completed");

  const alreadyCompleted = (completedCount ?? 0) > 0;

  if (alreadyCompleted) {
    log.info("orchestration already completed, replaying from DB");
  }

  const stream = new ReadableStream({
    async start(controller) {
      const closed = { value: false };

      request.signal.addEventListener("abort", () => {
        closed.value = true;
        log.info("client disconnected");
      });

      try {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "connected", workflowId })}\n\n`)
        );

        // ── Path 1: already completed → replay from DB directly ─────
        if (alreadyCompleted) {
          await replayFromDb(controller, closed);
          return;
        }

        // ── Path 2: still active → stream from Temporal ─────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let handle: any;
        let statusQuery: any;

        try {
          const temporal = await import("@guardian/temporal/client");
          statusQuery = temporal.statusQuery;
          const client = await temporal.getTemporalClient();
          handle = client.workflow.getHandle(workflowId);
        } catch (connErr) {
          // Temporal down → fallback to DB
          log.error(`Temporal unavailable: ${connErr}, falling back to DB`);
          await replayFromDb(controller, closed);
          return;
        }

        let lastKeepalive = Date.now();
        let pollCount = 0;
        let lastCursor = 0;
        let consecutiveErrors = 0;
        const MAX_CONSECUTIVE_ERRORS = 5;

        while (!closed.value) {
          try {
            const status: OrchestrationStatusResponse = await handle.query(statusQuery, lastCursor);

            consecutiveErrors = 0;
            pollCount++;
            lastCursor = status.eventCursor;

            if (status.events.length > 0) {
              log.info(`${status.events.length} new events`, {
                poll: pollCount,
                types: status.events.map((e: { type: string }) => e.type).join(","),
              });
            }
            for (const event of status.events) {
              if (closed.value) break;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }

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
            const msg = String(queryError);

            // Workflow gone from Temporal → replay from DB
            if (msg.includes("not found") || msg.includes("completed")) {
              log.info("workflow gone, replaying from DB", { polls: pollCount });
              await replayFromDb(controller, closed);
              break;
            }

            // Temporal connection errors → fallback after N consecutive failures
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              log.error(`${consecutiveErrors} consecutive Temporal errors, falling back to DB`);
              await replayFromDb(controller, closed);
              break;
            }

            if (Date.now() - lastKeepalive > KEEPALIVE_MS) {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              lastKeepalive = Date.now();
            }
          }

          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      } catch (err) {
        log.error(`stream error: ${err}`);
        if (!closed.value) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", message: String(err) })}\n\n`
            )
          );
        }
      } finally {
        if (!closed.value) {
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
