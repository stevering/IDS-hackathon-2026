/**
 * Persistence activities — saves orchestration state and durable events to Supabase.
 */

import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return null;
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

/** Event types that are persisted permanently (survive 7-day TTL). */
const DURABLE_EVENT_TYPES = new Set([
  "orchestration_started",
  "orchestrator_brief",
  "orchestrator_directive",
  "agent_report",
  "orchestration_completed",
]);

/** Map event type → message role for the messages table. */
function eventToMessageRole(eventType: string): "system" | "assistant" | "agent" | null {
  switch (eventType) {
    case "orchestration_started": return "system";
    case "orchestrator_brief": return "assistant";
    case "orchestrator_directive": return "assistant";
    case "agent_report": return "agent";
    case "orchestration_completed": return "system";
    default: return null;
  }
}

/** Extract text content from an event for the messages table. */
function eventToMessageContent(event: Record<string, unknown>): string {
  const type = event.type as string;
  switch (type) {
    case "orchestration_started":
      return `Orchestration started with agents: ${
        (event.agents as Array<{ shortId: string }>)?.map((a) => a.shortId).join(", ") ?? "unknown"
      }`;
    case "orchestrator_brief":
      return event.content as string ?? "";
    case "orchestrator_directive":
      return `[Directive → ${event.agentShortId}] ${event.content ?? ""}`;
    case "agent_report": {
      const report = event.report as Record<string, unknown> | undefined;
      return `[Report ← ${event.agentShortId}] ${report?.summary ?? report?.status ?? ""}`;
    }
    case "orchestration_completed":
      return `Orchestration ${event.status ?? "completed"}`;
    default:
      return JSON.stringify(event);
  }
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export async function saveOrchestrationState(params: {
  orchestrationId: string;
  status: string;
  agentResults: Record<string, unknown>;
  durationMs: number;
  userId: string;
}): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) {
    console.warn("[persistence] Supabase credentials not configured, skipping save");
    return;
  }

  const upsertData = {
    id: params.orchestrationId,
    user_id: params.userId,
    status: params.status,
    agent_results: params.agentResults,
    duration_ms: params.durationMs,
    completed_at: params.status !== "active" ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  console.log("[persistence] saveOrchestrationState:", params.orchestrationId, params.status);

  const { error, data } = await supabase.from("orchestrations").upsert(upsertData).select();

  if (error) {
    console.error("[persistence] Failed to save orchestration state:", error.message, error.code, error.details);
  }

}

/**
 * Persist orchestration events as a micro-batch.
 *
 * Called at the end of each orchestrator loop iteration.
 * ALL events are persisted to orchestration_events (durable flag set accordingly).
 * Only durable events also get written to the messages table.
 */
export async function persistDurableEvents(params: {
  workflowId: string;
  events: Array<Record<string, unknown>>;
  userId: string;
}): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) {
    console.warn("[persistence] Supabase credentials not configured, skipping events");
    return;
  }

  if (params.events.length === 0) return;

  // 1. Insert ALL events into orchestration_events (durable flag per type)
  const eventRows = params.events.map((e) => ({
    workflow_id: params.workflowId,
    event_type: (e.type as string) ?? "unknown",
    agent_id: (e.agentShortId as string) ?? null,
    payload: e,
    durable: DURABLE_EVENT_TYPES.has(e.type as string),
  }));

  const { error: eventsError } = await supabase
    .from("orchestration_events")
    .insert(eventRows);

  if (eventsError) {
    console.error("[persistence] Failed to persist events:", eventsError.message);
  }

  // 2. For durable events only: also write to messages table
  const durableEvents = params.events.filter(
    (e) => DURABLE_EVENT_TYPES.has(e.type as string)
  );

  if (durableEvents.length === 0) return;

  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("metadata->>workflowId", params.workflowId)
    .limit(1)
    .single();

  if (!conv) return;

  const messageRows = durableEvents
    .map((e) => {
      const role = eventToMessageRole(e.type as string);
      if (!role) return null;
      return {
        conversation_id: conv.id,
        role,
        content: eventToMessageContent(e),
        parts: null,
        sender_client_id: null,
        sender_short_id: (e.agentShortId as string) ?? null,
        metadata: { eventType: e.type, durable: true },
      };
    })
    .filter(Boolean);

  if (messageRows.length > 0) {
    const { error: msgError } = await supabase
      .from("messages")
      .insert(messageRows);

    if (msgError) {
      console.error("[persistence] Failed to persist durable messages:", msgError.message);
    }
  }
}
