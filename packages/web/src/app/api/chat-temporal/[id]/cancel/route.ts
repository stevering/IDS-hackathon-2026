/**
 * POST /api/chat-temporal/[id]/cancel
 *
 * Signals the chatCancel signal to a running chatWorkflow so the user can
 * stop an in-flight generation mid-stream. The workflow's signal handler
 * sets `cancelled = true`, which breaks the idle loop and terminates the
 * current LLM call as soon as control returns to the workflow.
 *
 * This is the only "stop button" surface for the Temporal chat — since
 * workflows run in the cloud, closing the browser tab does NOT cancel the
 * generation; the user has to come back and explicitly press Stop.
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";
import { createLogger } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workflowId } = await params;

  if (process.env.TEMPORAL_ENABLED !== "true") {
    return NextResponse.json({ error: "Temporal chat is not enabled" }, { status: 503 });
  }

  // Auth — we don't verify ownership here because Temporal workflow IDs are
  // already namespaced by user (`chat-<userIdPrefix>-<ts>`), and a signal on
  // a workflow that isn't running is a no-op. The auth check is kept so
  // unauthenticated callers can't hammer the Temporal cluster.
  const supabase = await createSupabaseUserClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const log = createLogger("chat-temporal/cancel", { u: user.id.slice(0, 8), wf: workflowId });

  try {
    const { getTemporalClient } = await import("@guardian/temporal/client");
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId);

    const desc = await handle.describe();
    if (desc.status.name !== "RUNNING") {
      log.info("workflow not running — cancel is a no-op", { status: desc.status.name });
      return NextResponse.json({ workflowId, status: desc.status.name, action: "noop" });
    }

    await handle.signal("chatCancel");
    log.info("chatCancel signal sent");
    return NextResponse.json({ workflowId, action: "cancelled" });
  } catch (err) {
    // Correlatable error ID — matches the pattern used by start/message routes.
    const errId = `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("failed to signal chatCancel", { errId, error: errMsg });
    return NextResponse.json(
      { error: `Failed to cancel chat workflow: ${errMsg}`, errId },
      { status: 500 }
    );
  }
}
