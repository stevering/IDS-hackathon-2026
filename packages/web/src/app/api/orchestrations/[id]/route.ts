import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ id: string }> };

/** GET /api/orchestrations/[id] — get a single orchestration with its collaborators. */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: orch, error: orchErr } = await supabase
    .from("orchestrations")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (orchErr || !orch) {
    return NextResponse.json({ error: "Orchestration not found" }, { status: 404 });
  }

  // Fetch collaborator clients for this orchestration
  const { data: collaborators } = await supabase
    .from("user_clients")
    .select("client_id, client_type, short_id, label, agent_role")
    .eq("user_id", user.id)
    .eq("orchestration_id", id)
    .eq("agent_role", "collaborator");

  return NextResponse.json({ orchestration: orch, collaborators: collaborators ?? [] });
}

/** PATCH /api/orchestrations/[id] — complete or cancel an orchestration. */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const status = body?.status;
  if (!status || !["completed", "cancelled"].includes(status)) {
    return NextResponse.json(
      { error: "status must be 'completed' or 'cancelled'" },
      { status: 400 },
    );
  }

  const { error } = await supabase.rpc("complete_orchestration", {
    p_orchestration_id: id,
    p_status: status,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
