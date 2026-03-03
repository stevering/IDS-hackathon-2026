import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** PATCH /api/user/api-keys/default — set a provider as the default key. */
export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { provider } = body ?? {};
  if (!provider) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }

  const { error } = await supabase.rpc("set_default_api_key", { p_provider: provider });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
