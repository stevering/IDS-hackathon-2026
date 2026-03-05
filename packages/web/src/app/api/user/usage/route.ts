import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const FREE_TIER_DAILY_TOKEN_LIMIT = 500_000;

/** GET /api/user/usage — returns rolling 24h token usage for authenticated user. */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase.rpc("get_current_usage");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tokens_used: data ?? 0, daily_limit: FREE_TIER_DAILY_TOKEN_LIMIT });
}
