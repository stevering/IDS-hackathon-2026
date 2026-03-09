import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** POST /api/orchestrations — create an orchestration session. */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { clientId, conversationId } = body ?? {};
  if (!clientId || !conversationId) {
    return NextResponse.json(
      { error: "clientId and conversationId are required" },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("create_orchestration", {
    p_client_id: clientId,
    p_conversation_id: conversationId,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ orchestrationId: data });
}

/** GET /api/orchestrations — list active orchestrations for the current user. */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("orchestrations")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ orchestrations: data });
}
