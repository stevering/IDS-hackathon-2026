import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** GET /api/user/api-keys — list the authenticated user's stored providers (no secrets). */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("user_api_keys")
    .select("id, provider, is_default, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ keys: data });
}

/** POST /api/user/api-keys — store or update a key (encrypted in Vault). */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { provider, secret } = body ?? {};
  if (!provider || !secret) {
    return NextResponse.json({ error: "provider and secret are required" }, { status: 400 });
  }

  const { error } = await supabase.rpc("upsert_api_key", { p_provider: provider, p_secret: secret });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** DELETE /api/user/api-keys?provider=xxx — remove a stored key. */
export async function DELETE(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const provider = new URL(req.url).searchParams.get("provider");
  if (!provider) {
    return NextResponse.json({ error: "provider query param required" }, { status: 400 });
  }

  const { error } = await supabase.rpc("delete_api_key", { p_provider: provider });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
