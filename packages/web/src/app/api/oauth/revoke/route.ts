import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { hashRefreshToken } from "@/lib/oauth/pkce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RFC 7009 — OAuth 2.0 Token Revocation.
// Revokes a refresh token and (by default) removes the associated device row,
// which cascades to local MCP instances.
export async function POST(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  let token: string | undefined;
  let deleteDevice = true;

  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string;
      delete_device?: boolean;
    };
    token = body.token;
    if (body.delete_device === false) deleteDevice = false;
  } else {
    const form = new URLSearchParams(await req.text());
    token = form.get("token") ?? undefined;
    if (form.get("delete_device") === "false") deleteDevice = false;
  }

  if (!token) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "token is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const admin = createServiceClient();
  const hash = hashRefreshToken(token);

  const { data: row } = await admin
    .from("oauth_refresh_tokens")
    .select("token_hash, device_id, revoked_at")
    .eq("token_hash", hash)
    .maybeSingle();

  // RFC 7009 §2.2: respond 200 even if the token is unknown (prevents probing).
  if (!row || row.revoked_at) {
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }

  await admin
    .from("oauth_refresh_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", hash);

  if (deleteDevice && row.device_id) {
    await admin.from("user_devices").delete().eq("id", row.device_id);
  }

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
