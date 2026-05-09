import { NextRequest, NextResponse } from "next/server";
import { COOKIE_TOKENS, COOKIE_CLIENT_INFO, COOKIE_CODE_VERIFIER, COOKIE_STATE } from "@/lib/figma-mcp-oauth";
import { createClient } from "@/lib/supabase/server";

const SERVER_ID = "figma_mcp";

export async function GET(req: NextRequest) {
  // Cookie path — fast and works for top-level webapp usage.
  if (req.cookies.get(COOKIE_TOKENS)?.value) {
    return NextResponse.json({ connected: true });
  }

  // Vault path — required when the webapp runs inside the Figma plugin iframe,
  // where SameSite=Lax OAuth cookies are not sent on cross-site fetches.
  // The user's Supabase session uses SameSite=None and reaches us here.
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
    console.error("[Figma MCP Status] Vault lookup failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ connected: false });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(COOKIE_TOKENS);
  response.cookies.delete(COOKIE_CLIENT_INFO);
  response.cookies.delete(COOKIE_CODE_VERIFIER);
  response.cookies.delete(COOKIE_STATE);
  return response;
}
