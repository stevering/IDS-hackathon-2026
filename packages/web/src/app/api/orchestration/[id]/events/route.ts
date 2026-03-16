/**
 * GET /api/orchestration/[id]/events
 * Fetch persisted orchestration events for replay (old collabs).
 *
 * POST /api/orchestration/[id]/events
 * Persist a batch of SSE events (fire-and-forget from the client stream).
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workflowId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("orchestration_events")
    .select("*")
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ events: data });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workflowId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body?.events || !Array.isArray(body.events) || body.events.length === 0) {
    return NextResponse.json({ error: "Missing events array" }, { status: 400 });
  }

  // Use service client to bypass RLS for inserts
  const service = createServiceClient();

  const rows = body.events.map((e: { type?: string; agentId?: string; [key: string]: unknown }) => ({
    workflow_id: workflowId,
    event_type: e.type ?? "unknown",
    agent_id: e.agentId ?? null,
    payload: e,
  }));

  const { error } = await service
    .from("orchestration_events")
    .insert(rows);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, count: rows.length });
}
