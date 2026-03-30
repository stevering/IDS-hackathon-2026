import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** PATCH /api/user/api-keys/model — update a key's default model by ID. */
export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { id, defaultModel } = body ?? {};
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (typeof defaultModel !== "string" && defaultModel !== null) {
    return NextResponse.json({ error: "defaultModel must be a string or null" }, { status: 400 });
  }

  const { error } = await supabase.rpc("update_key_default_model", {
    p_key_id: id,
    p_default_model: defaultModel,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
