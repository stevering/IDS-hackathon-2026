import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const FREE_TIER_DAILY_TOKEN_LIMIT = 500_000;

type UsageAggregate = {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cost_input_usd: number;
  cost_output_usd: number;
};

const EMPTY_USAGE: UsageAggregate = {
  total_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  cost_input_usd: 0,
  cost_output_usd: 0,
};

function parseUsage(data: unknown): UsageAggregate {
  if (!data || typeof data !== "object") return EMPTY_USAGE;
  const d = data as Record<string, unknown>;
  return {
    total_tokens: Number(d.total_tokens ?? 0),
    input_tokens: Number(d.input_tokens ?? 0),
    output_tokens: Number(d.output_tokens ?? 0),
    cost_input_usd: Number(d.cost_input_usd ?? 0),
    cost_output_usd: Number(d.cost_output_usd ?? 0),
  };
}

/** GET /api/user/usage — returns rolling 24h, 30-day, and lifetime token + cost usage. */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [dailyRes, monthlyRes, lifetimeRes] = await Promise.all([
    supabase.rpc("get_current_usage"),
    supabase.rpc("get_monthly_usage"),
    supabase.rpc("get_lifetime_usage"),
  ]);

  if (dailyRes.error) return NextResponse.json({ error: dailyRes.error.message }, { status: 500 });

  return NextResponse.json({
    daily: { ...parseUsage(dailyRes.data), limit: FREE_TIER_DAILY_TOKEN_LIMIT },
    monthly: parseUsage(monthlyRes.data),
    lifetime: parseUsage(lifetimeRes.data),
  });
}
