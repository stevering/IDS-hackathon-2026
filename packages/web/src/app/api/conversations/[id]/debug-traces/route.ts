/**
 * POST /api/conversations/[id]/debug-traces  — Push a client's trace
 * GET  /api/conversations/[id]/debug-traces  — Fetch unified debug report
 *
 * When `workflowId` is provided (orchestration mode), traces are indexed by
 * workflow_id so all clients participating in the same orchestration can be
 * merged — even though they each have a different conversation_id.
 *
 * For classic (single-client) conversations, traces are indexed by conversation_id.
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST — Push (upsert) a client's trace
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: conversationId } = await params;

  const supabase = await createSupabaseUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify conversation belongs to the user
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (convErr || !conv) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  let body: {
    sourceClientId: string;
    sourceShortId?: string;
    clientType?: string;
    events: unknown[];
    clientState?: Record<string, unknown>;
    workflowId?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.sourceClientId || !Array.isArray(body.events)) {
    return NextResponse.json(
      { error: "sourceClientId and events[] required" },
      { status: 400 }
    );
  }

  const row = {
    user_id: user.id,
    conversation_id: conversationId,
    source_client_id: body.sourceClientId,
    source_short_id: body.sourceShortId ?? null,
    client_type: body.clientType ?? null,
    events: body.events,
    client_state: body.clientState ?? {},
    workflow_id: body.workflowId ?? null,
    pushed_at: new Date().toISOString(),
  };

  // When workflowId is set, we need a different upsert strategy:
  // - Delete any previous trace for this (workflow_id, source_client_id) combo
  //   (may be under a different conversation_id)
  // - Then insert fresh
  // For classic mode, use the standard (conversation_id, source_client_id) upsert.
  let upsertErr;

  if (body.workflowId) {
    // Delete existing trace for this client in this workflow (any conversation)
    await supabase
      .from("debug_traces")
      .delete()
      .eq("workflow_id", body.workflowId)
      .eq("source_client_id", body.sourceClientId);

    const { error } = await supabase.from("debug_traces").insert(row);
    upsertErr = error;
  } else {
    const { error } = await supabase
      .from("debug_traces")
      .upsert(row, { onConflict: "conversation_id,source_client_id" });
    upsertErr = error;
  }

  if (upsertErr) {
    console.error("[debug-traces] upsert failed:", upsertErr);
    return NextResponse.json(
      { error: "Failed to save trace" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// GET — Fetch unified debug report (all clients + optional Temporal history)
// ---------------------------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: conversationId } = await params;
  const url = new URL(request.url);
  const workflowId = url.searchParams.get("workflowId");

  const supabase = await createSupabaseUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify conversation ownership
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id, orchestration_id")
    .eq("id", conversationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (convErr || !conv) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  // Fetch traces: by workflow_id (orchestration) or conversation_id (classic)
  let query = supabase
    .from("debug_traces")
    .select("*")
    .eq("user_id", user.id)
    .order("pushed_at", { ascending: true });

  if (workflowId) {
    query = query.eq("workflow_id", workflowId);
  } else {
    query = query.eq("conversation_id", conversationId);
  }

  const { data: traces, error: tracesErr } = await query;

  if (tracesErr) {
    console.error("[debug-traces] fetch failed:", tracesErr);
    return NextResponse.json(
      { error: "Failed to fetch traces" },
      { status: 500 }
    );
  }

  // Optional: fetch Temporal workflow history
  const temporalWorkflowId = workflowId ?? conv.orchestration_id;
  let temporalHistory: {
    ts: string;
    type: string;
    detail?: Record<string, unknown>;
  }[] | undefined;

  if (temporalWorkflowId && process.env.TEMPORAL_ENABLED === "true") {
    try {
      temporalHistory = await fetchTemporalHistory(temporalWorkflowId);
    } catch (err) {
      console.error("[debug-traces] Temporal history fetch failed:", err);
    }
  }

  return NextResponse.json({
    conversationId,
    orchestrationId: conv.orchestration_id ?? undefined,
    workflowId: workflowId ?? undefined,
    traces: (traces ?? []).map(
      (t: {
        source_client_id: string;
        source_short_id: string | null;
        client_type: string | null;
        events: unknown[];
        client_state: Record<string, unknown>;
        pushed_at: string;
      }) => ({
        sourceClientId: t.source_client_id,
        sourceShortId: t.source_short_id,
        clientType: t.client_type,
        events: t.events,
        clientState: t.client_state,
        pushedAt: t.pushed_at,
      })
    ),
    ...(temporalHistory ? { temporalHistory } : {}),
  });
}

// ---------------------------------------------------------------------------
// Temporal history formatter
// ---------------------------------------------------------------------------

async function fetchTemporalHistory(
  workflowId: string
): Promise<{ ts: string; type: string; detail?: Record<string, unknown> }[]> {
  const { getTemporalClient } = await import("@guardian/temporal/client");
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);

  const history: {
    ts: string;
    type: string;
    detail?: Record<string, unknown>;
  }[] = [];

  try {
    const iter = handle.fetchHistory();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const event of (iter as any).events ?? iter) {
      const mapped = mapHistoryEvent(event);
      if (mapped) history.push(mapped);
    }
  } catch {
    // fetchHistory may fail if workflow not found — non-fatal
  }

  return history;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapHistoryEvent(event: any): {
  ts: string;
  type: string;
  detail?: Record<string, unknown>;
} | null {
  const ts = event.eventTime
    ? new Date(
        Number(event.eventTime.seconds ?? 0) * 1000 +
          Number(event.eventTime.nanos ?? 0) / 1e6
      ).toISOString()
    : new Date().toISOString();

  const eventType: string = event.eventType ?? "";

  if (eventType.includes("WORKFLOW_EXECUTION_STARTED")) {
    return { ts, type: "workflow_started" };
  }
  if (eventType.includes("WORKFLOW_EXECUTION_COMPLETED")) {
    return { ts, type: "workflow_completed" };
  }
  if (eventType.includes("WORKFLOW_EXECUTION_FAILED")) {
    return {
      ts,
      type: "workflow_failed",
      detail: { failure: event.workflowExecutionFailedEventAttributes?.failure?.message },
    };
  }
  if (eventType.includes("SIGNAL_EXTERNAL_WORKFLOW") || eventType.includes("WORKFLOW_EXECUTION_SIGNALED")) {
    const attrs = event.workflowExecutionSignaledEventAttributes;
    return {
      ts,
      type: "signal_received",
      detail: {
        signalName: attrs?.signalName,
        ...(attrs?.input ? { payloadSummary: summarizePayload(attrs.input) } : {}),
      },
    };
  }
  if (eventType.includes("ACTIVITY_TASK_SCHEDULED")) {
    const attrs = event.activityTaskScheduledEventAttributes;
    return {
      ts,
      type: "activity_scheduled",
      detail: { activityType: attrs?.activityType?.name },
    };
  }
  if (eventType.includes("ACTIVITY_TASK_COMPLETED")) {
    return { ts, type: "activity_completed" };
  }
  if (eventType.includes("ACTIVITY_TASK_FAILED")) {
    const attrs = event.activityTaskFailedEventAttributes;
    return {
      ts,
      type: "activity_failed",
      detail: { failure: attrs?.failure?.message },
    };
  }
  if (eventType.includes("START_CHILD_WORKFLOW_EXECUTION")) {
    const attrs = event.startChildWorkflowExecutionInitiatedEventAttributes;
    return {
      ts,
      type: "child_workflow_started",
      detail: { workflowType: attrs?.workflowType?.name },
    };
  }
  if (eventType.includes("CHILD_WORKFLOW_EXECUTION_COMPLETED")) {
    return { ts, type: "child_workflow_completed" };
  }
  if (eventType.includes("TIMER_STARTED")) {
    return { ts, type: "timer_started" };
  }
  if (eventType.includes("TIMER_FIRED")) {
    return { ts, type: "timer_fired" };
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizePayload(input: any): string {
  try {
    if (input?.payloads?.[0]?.data) {
      const raw = Buffer.from(input.payloads[0].data, "base64").toString();
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed).slice(0, 200);
    }
  } catch {
    // ignore
  }
  return "(binary)";
}
