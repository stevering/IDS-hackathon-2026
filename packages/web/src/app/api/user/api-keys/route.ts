import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** GET /api/user/api-keys — list the authenticated user's stored keys (no secrets). */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("user_api_keys")
    .select("id, provider, label, key_hint, is_default, default_model, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ keys: data });
}

/** POST /api/user/api-keys — add a new API key. */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { provider, secret, label } = body ?? {};
  if (!provider || !secret) {
    return NextResponse.json({ error: "provider and secret are required" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("insert_api_key", {
    p_provider: provider,
    p_secret: secret,
    p_label: label || null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data });
}

/** DELETE /api/user/api-keys?id=xxx — remove a stored key by ID. */
export async function DELETE(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const keyId = new URL(req.url).searchParams.get("id");
  if (!keyId) {
    return NextResponse.json({ error: "id query param required" }, { status: 400 });
  }

  const { error } = await supabase.rpc("delete_api_key", { p_key_id: keyId });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If no keys remain, reset to included free tier
  const { data: remaining } = await supabase
    .from("user_api_keys")
    .select("id")
    .eq("user_id", user.id)
    .limit(1);

  if (!remaining || remaining.length === 0) {
    await supabase.rpc("update_settings", { p_usage_source: "included" });
  }

  return NextResponse.json({ ok: true });
}
