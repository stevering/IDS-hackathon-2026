import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** GET /api/user/settings — get current user's settings. */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase.rpc("get_or_create_settings");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({
    autoAccept: row?.auto_accept ?? false,
    defaultModel: row?.default_model ?? null,
  });
}

/** PATCH /api/user/settings — update user settings. */
export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { autoAccept, defaultModel } = body;

  // At least one field must be provided
  if (typeof autoAccept === "undefined" && typeof defaultModel === "undefined") {
    return NextResponse.json(
      { error: "At least one setting (autoAccept, defaultModel) is required" },
      { status: 400 },
    );
  }

  // Validate types when provided
  if (typeof autoAccept !== "undefined" && typeof autoAccept !== "boolean") {
    return NextResponse.json({ error: "autoAccept must be a boolean" }, { status: 400 });
  }
  if (typeof defaultModel !== "undefined" && defaultModel !== null && typeof defaultModel !== "string") {
    return NextResponse.json({ error: "defaultModel must be a string or null" }, { status: 400 });
  }

  // Build RPC params — only pass what was provided
  const params: Record<string, unknown> = {};
  if (typeof autoAccept !== "undefined") params.p_auto_accept = autoAccept;
  if (typeof defaultModel !== "undefined") params.p_default_model = defaultModel;

  const { error } = await supabase.rpc("update_settings", params);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, autoAccept, defaultModel });
}
