import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";

/** Cookie name → server ID mapping */
const COOKIE_TO_SERVER: Record<string, { serverId: string; scopes: string }> = {
  github_mcp_tokens: { serverId: "github", scopes: "repo" },
  southleft_mcp_tokens: { serverId: "figma_console", scopes: "file_content:read,library_content:read,file_variables:read" },
};

/** POST /api/user/connected-services/persist — persist OAuth tokens to Vault.
 *  Reads tokens from cookies (set by OAuth callback popup) and persists to Supabase Vault.
 *  Called from the main page which has the Supabase session. */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const cookieStore = await cookies();
  const persisted: string[] = [];

  // If explicit serverId + tokensJson passed in body, use those
  if (body?.serverId && body?.tokensJson) {
    try {
      const parsed = JSON.parse(body.tokensJson);
      const expiresAt = parsed.expires_in
        ? new Date(Date.now() + parsed.expires_in * 1000).toISOString()
        : null;
      await supabase.rpc("upsert_mcp_connection", {
        p_server_id: body.serverId,
        p_tokens_json: body.tokensJson,
        p_scopes: body.scopes ?? null,
        p_expires_at: expiresAt,
      });
      persisted.push(body.serverId);
    } catch { /* continue */ }
  }

  // Also scan known OAuth cookies and persist any found
  for (const [cookieName, { serverId, scopes }] of Object.entries(COOKIE_TO_SERVER)) {
    const tokensCookie = cookieStore.get(cookieName)?.value;
    if (!tokensCookie) continue;

    try {
      const parsed = JSON.parse(tokensCookie);
      const expiresAt = parsed.expires_in
        ? new Date(Date.now() + parsed.expires_in * 1000).toISOString()
        : null;
      await supabase.rpc("upsert_mcp_connection", {
        p_server_id: serverId,
        p_tokens_json: tokensCookie,
        p_scopes: scopes,
        p_expires_at: expiresAt,
      });
      persisted.push(serverId);
    } catch { /* non-fatal, continue with other cookies */ }
  }

  return NextResponse.json({ ok: true, persisted });
}
