import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** PATCH /api/clients/role — update a client's agent role. */
export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { clientId, role, orchestrationId } = body ?? {};
  if (!clientId || !role) {
    return NextResponse.json(
      { error: "clientId and role are required" },
      { status: 400 },
    );
  }

  if (!["idle", "orchestrator", "collaborator"].includes(role)) {
    return NextResponse.json(
      { error: "role must be 'idle', 'orchestrator', or 'collaborator'" },
      { status: 400 },
    );
  }

  const { error } = await supabase.rpc("update_client_role", {
    p_client_id: clientId,
    p_role: role,
    p_orchestration_id: orchestrationId ?? null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
