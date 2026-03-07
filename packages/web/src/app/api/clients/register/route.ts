import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** POST /api/clients/register — register a client instance and get a stable shortId. */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { clientId, clientType, label, fileKey } = body ?? {};
  if (!clientId || !clientType) {
    return NextResponse.json({ error: "clientId and clientType are required" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("register_client", {
    p_client_id: clientId,
    p_client_type: clientType,
    p_label: label ?? null,
    p_file_key: fileKey ?? null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({ shortId: row.short_id, isNew: row.is_new });
}
