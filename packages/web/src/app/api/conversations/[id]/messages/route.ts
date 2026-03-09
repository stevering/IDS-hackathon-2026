import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ id: string }> };

/** GET /api/conversations/[id]/messages — get messages for a conversation. */
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Verify conversation ownership
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!conv) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100"), 200);
  const before = url.searchParams.get("before"); // cursor-based pagination

  let query = supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .limit(limit + 1); // fetch one extra to determine hasMore

  if (before) {
    query = query.lt("created_at", before);
  }

  const { data: messages, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const hasMore = (messages?.length ?? 0) > limit;
  const result = hasMore ? messages!.slice(0, limit) : (messages ?? []);

  return NextResponse.json({ messages: result, hasMore });
}

/** POST /api/conversations/[id]/messages — save a message. */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || !body.role || !body.content) {
    return NextResponse.json({ error: "role and content are required" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("save_message", {
    p_conversation_id: id,
    p_role: body.role,
    p_content: body.content,
    p_parts: body.parts ?? null,
    p_sender_client_id: body.senderClientId ?? null,
    p_sender_short_id: body.senderShortId ?? null,
    p_metadata: body.metadata ?? {},
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ message: { id: data } }, { status: 201 });
}
