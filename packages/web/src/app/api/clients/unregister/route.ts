import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** POST /api/clients/unregister — remove a client from the registry. */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { clientId } = body ?? {};
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const { error } = await supabase.rpc("unregister_client", {
    p_client_id: clientId,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
