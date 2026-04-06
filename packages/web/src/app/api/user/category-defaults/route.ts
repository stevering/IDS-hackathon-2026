import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/user/category-defaults — current default instance per category.
 * PUT /api/user/category-defaults — set default instance for a category.
 */

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("user_category_defaults")
    .select("category, instance_id");

  const defaults: Record<string, string | null> = { design: null, code: null };
  for (const d of data ?? []) {
    const cat = d.category as string;
    if (cat === "design" || cat === "code") {
      defaults[cat] = (d.instance_id as string | null) ?? null;
    }
  }

  return NextResponse.json({ defaults });
}

export async function PUT(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const category = body.category as string | undefined;
  if (category !== "design" && category !== "code") {
    return NextResponse.json({ error: "category must be 'design' or 'code'" }, { status: 400 });
  }

  const instanceId = body.instance_id as string | null;

  // Validate instance belongs to this user and matches the category
  if (instanceId) {
    const { data: inst } = await supabase
      .from("user_mcp_instances")
      .select("category")
      .eq("id", instanceId)
      .eq("user_id", user.id)
      .single();

    if (!inst) {
      return NextResponse.json({ error: "Instance not found" }, { status: 404 });
    }
    if ((inst.category as string) !== category) {
      return NextResponse.json({ error: `Instance category mismatch: expected ${category}` }, { status: 400 });
    }
  }

  const { error } = await supabase
    .from("user_category_defaults")
    .upsert(
      { user_id: user.id, category, instance_id: instanceId, updated_at: new Date().toISOString() },
      { onConflict: "user_id,category" },
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
