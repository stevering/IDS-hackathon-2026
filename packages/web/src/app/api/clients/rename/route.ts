import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** PATCH /api/clients/rename — rename a client's display shortId. */
export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { clientId, shortId } = body ?? {};

  if (!clientId || !shortId) {
    return NextResponse.json({ error: "clientId and shortId are required" }, { status: 400 });
  }

  const trimmed = String(shortId).trim();
  if (trimmed.length < 2 || trimmed.length > 30) {
    return NextResponse.json({ error: "Name must be between 2 and 30 characters" }, { status: 400 });
  }

  const { error } = await supabase.rpc("rename_client", {
    p_client_id: clientId,
    p_short_id: trimmed,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, shortId: trimmed });
}
