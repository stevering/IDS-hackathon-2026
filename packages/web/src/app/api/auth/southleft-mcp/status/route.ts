import { NextRequest, NextResponse } from "next/server";
import {
  SOUTHLEFT_COOKIE_TOKENS,
  SOUTHLEFT_COOKIE_CLIENT_INFO,
  SOUTHLEFT_COOKIE_CODE_VERIFIER,
  SOUTHLEFT_COOKIE_STATE,
} from "@/lib/southleft-mcp-oauth";
import { createClient } from "@/lib/supabase/server";

const SERVER_ID = "figma_console";

export async function GET(req: NextRequest) {
  if (req.cookies.get(SOUTHLEFT_COOKIE_TOKENS)?.value) {
    return NextResponse.json({ connected: true });
  }

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ connected: false });
    const { data } = await supabase
      .from("user_mcp_connections")
      .select("server_id")
      .eq("user_id", user.id)
      .eq("server_id", SERVER_ID)
      .maybeSingle();
    return NextResponse.json({ connected: !!data });
  } catch (err) {
    console.error("[Southleft Status] Vault lookup failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ connected: false });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SOUTHLEFT_COOKIE_TOKENS);
  response.cookies.delete(SOUTHLEFT_COOKIE_CLIENT_INFO);
  response.cookies.delete(SOUTHLEFT_COOKIE_CODE_VERIFIER);
  response.cookies.delete(SOUTHLEFT_COOKIE_STATE);
  return response;
}
