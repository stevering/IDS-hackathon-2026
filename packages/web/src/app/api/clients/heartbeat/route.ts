import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** POST /api/clients/heartbeat — update last_seen_at for a registered client. */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { clientId, fileKey, label } = body ?? {};
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const { error } = await supabase.rpc("heartbeat_client", {
    p_client_id: clientId,
    p_file_key: fileKey ?? null,
    p_label: label ?? null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
