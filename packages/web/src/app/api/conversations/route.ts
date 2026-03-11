import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** GET /api/conversations — list conversations for the authenticated user. */
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") ?? "0");
  const orchestrationId = url.searchParams.get("orchestration_id");
  const clientId = url.searchParams.get("client_id");

  let query = supabase
    .from("conversations")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (orchestrationId) {
    query = query.eq("orchestration_id", orchestrationId);
  }

  // Filter by client_id: show conversations owned by this client OR shared ones (null client_id)
  if (clientId) {
    query = query.or(`client_id.eq.${clientId},client_id.is.null`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ conversations: data });
}

/** POST /api/conversations — create a new conversation. */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { title, clientId, parentId, orchestrationId, metadata } = body ?? {};

  const { data, error } = await supabase.rpc("create_conversation", {
    p_client_id: clientId ?? null,
    p_title: title ?? "New conversation",
    p_parent_id: parentId ?? null,
    p_orchestration_id: orchestrationId ?? null,
    p_metadata: metadata ?? {},
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Fetch the created conversation to return full object
  const { data: conv } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", data)
    .single();

  return NextResponse.json({ conversation: conv }, { status: 201 });
}
