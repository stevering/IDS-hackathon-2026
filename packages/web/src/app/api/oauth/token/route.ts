import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  createRefreshToken,
  hashRefreshToken,
  verifyPKCE,
} from "@/lib/oauth/pkce";
import { mintSupabaseSessionForUser } from "@/lib/oauth/session-mint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RFC 6749 §5.2 error response shape.
function oauthError(error: string, description?: string, status = 400) {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

function tokenResponse(body: Record<string, unknown>) {
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

type TokenBody = Record<string, string | undefined>;

async function parseBody(req: Request): Promise<TokenBody> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return (await req.json().catch(() => ({}))) as TokenBody;
  }
  // application/x-www-form-urlencoded (standard OAuth)
  const text = await req.text();
  const params = new URLSearchParams(text);
  const out: TokenBody = {};
  params.forEach((v, k) => (out[k] = v));
  return out;
}

const REFRESH_TTL_DAYS = 30;
const ACCESS_DEFAULT_EXPIRES_IN = 3600; // Supabase default; real value from session.

export async function POST(req: Request) {
  const body = await parseBody(req);
  const grantType = body.grant_type;

  if (grantType === "authorization_code") {
    return handleAuthorizationCode(body);
  }
  if (grantType === "refresh_token") {
    return handleRefreshToken(body);
  }
  return oauthError("unsupported_grant_type", `grant_type=${grantType ?? "missing"}`);
}

async function handleAuthorizationCode(body: TokenBody) {
  const { code, code_verifier, redirect_uri, client_id } = body;

  if (!code || !code_verifier || !redirect_uri || !client_id) {
    return oauthError(
      "invalid_request",
      "code, code_verifier, redirect_uri and client_id are required",
    );
  }

  const admin = createServiceClient();

  // 1. Look up the auth code (single-use, short-lived, bound to client + redirect + PKCE).
  const { data: authCode, error: fetchErr } = await admin
    .from("oauth_authorization_codes")
    .select(
      "code, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, device_fingerprint, device_name, consumed_at, expires_at",
    )
    .eq("code", code)
    .maybeSingle();

  if (fetchErr) return oauthError("server_error", fetchErr.message, 500);
  if (!authCode) return oauthError("invalid_grant", "unknown authorization code");
  if (authCode.consumed_at) return oauthError("invalid_grant", "code already used");
  if (new Date(authCode.expires_at).getTime() < Date.now()) {
    return oauthError("invalid_grant", "code expired");
  }
  if (authCode.client_id !== client_id) {
    return oauthError("invalid_grant", "client_id mismatch");
  }
  // Exact match required per RFC 6749 §4.1.3 — the client MUST send back the
  // same redirect_uri it used in /authorize. (Loopback port was already fixed
  // at /authorize time and stored in the auth code row.)
  if (authCode.redirect_uri !== redirect_uri) {
    return oauthError("invalid_grant", "redirect_uri mismatch");
  }
  if (authCode.code_challenge_method !== "S256") {
    return oauthError("invalid_grant", "unsupported code_challenge_method");
  }
  if (!verifyPKCE(code_verifier, authCode.code_challenge)) {
    return oauthError("invalid_grant", "PKCE verification failed");
  }

  // 2. Mark code consumed (single-use, even on downstream failure).
  const { error: consumeErr } = await admin
    .from("oauth_authorization_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("code", code)
    .is("consumed_at", null);
  if (consumeErr) return oauthError("server_error", consumeErr.message, 500);

  // 3. Upsert the user_devices row (idempotent on fingerprint).
  let deviceId: string | null = null;
  if (authCode.device_fingerprint) {
    const { data: existing } = await admin
      .from("user_devices")
      .select("id")
      .eq("user_id", authCode.user_id)
      .eq("device_fingerprint", authCode.device_fingerprint)
      .maybeSingle();

    if (existing) {
      deviceId = existing.id;
      await admin
        .from("user_devices")
        .update({
          device_name: authCode.device_name ?? "Desktop Companion",
          last_seen_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      const { data: inserted, error: insertErr } = await admin
        .from("user_devices")
        .insert({
          user_id: authCode.user_id,
          device_fingerprint: authCode.device_fingerprint,
          device_name: authCode.device_name ?? "Desktop Companion",
        })
        .select("id")
        .single();
      if (insertErr) return oauthError("server_error", insertErr.message, 500);
      deviceId = inserted.id;
    }
  }

  // 4. Mint a Supabase-native session (access + refresh) for the user.
  let session;
  try {
    session = await mintSupabaseSessionForUser(authCode.user_id);
  } catch (e) {
    return oauthError("server_error", (e as Error).message, 500);
  }

  // 5. Mint our OAuth refresh token (separate from Supabase's), bound to device.
  const guardianRefresh = createRefreshToken();
  const guardianRefreshHash = hashRefreshToken(guardianRefresh);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000).toISOString();

  const { error: refreshErr } = await admin.from("oauth_refresh_tokens").insert({
    token_hash: guardianRefreshHash,
    client_id,
    user_id: authCode.user_id,
    device_id: deviceId,
    scope: authCode.scope,
    expires_at: refreshExpiresAt,
    last_used_at: new Date().toISOString(),
  });
  if (refreshErr) return oauthError("server_error", refreshErr.message, 500);

  return tokenResponse({
    // Supabase-native session: usable with supabase.auth.setSession(...)
    access_token: session.access_token,
    supabase_refresh_token: session.refresh_token,
    token_type: "Bearer",
    expires_in: session.expires_in ?? ACCESS_DEFAULT_EXPIRES_IN,
    // Our OAuth refresh token: used against /api/oauth/token (grant_type=refresh_token).
    refresh_token: guardianRefresh,
    scope: authCode.scope,
    user_id: authCode.user_id,
    device_id: deviceId,
    // Public Supabase config so the companion can open a Realtime channel
    // (anon key is public by design).
    supabase_url: process.env.NEXT_PUBLIC_STORAGE_SUPABASE_URL,
    supabase_anon_key: process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY,
  });
}

async function handleRefreshToken(body: TokenBody) {
  const { refresh_token, client_id } = body;
  if (!refresh_token || !client_id) {
    return oauthError("invalid_request", "refresh_token and client_id are required");
  }

  const admin = createServiceClient();
  const hash = hashRefreshToken(refresh_token);

  const { data: row, error } = await admin
    .from("oauth_refresh_tokens")
    .select("token_hash, client_id, user_id, device_id, scope, revoked_at, expires_at")
    .eq("token_hash", hash)
    .maybeSingle();

  if (error) return oauthError("server_error", error.message, 500);
  if (!row) return oauthError("invalid_grant", "unknown refresh token");
  if (row.revoked_at) return oauthError("invalid_grant", "refresh token revoked");
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return oauthError("invalid_grant", "refresh token expired");
  }
  if (row.client_id !== client_id) {
    return oauthError("invalid_grant", "client_id mismatch");
  }

  // Rotate: revoke old, mint new.
  const now = new Date().toISOString();
  const { error: revokeErr } = await admin
    .from("oauth_refresh_tokens")
    .update({ revoked_at: now, last_used_at: now })
    .eq("token_hash", hash);
  if (revokeErr) return oauthError("server_error", revokeErr.message, 500);

  // Re-mint Supabase session (fresh magiclink+verifyOtp cycle).
  let session;
  try {
    session = await mintSupabaseSessionForUser(row.user_id);
  } catch (e) {
    return oauthError("server_error", (e as Error).message, 500);
  }

  const newRaw = createRefreshToken();
  const newHash = hashRefreshToken(newRaw);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000).toISOString();

  const { error: insertErr } = await admin.from("oauth_refresh_tokens").insert({
    token_hash: newHash,
    client_id,
    user_id: row.user_id,
    device_id: row.device_id,
    scope: row.scope,
    expires_at: refreshExpiresAt,
    last_used_at: now,
  });
  if (insertErr) return oauthError("server_error", insertErr.message, 500);

  return tokenResponse({
    access_token: session.access_token,
    supabase_refresh_token: session.refresh_token,
    token_type: "Bearer",
    expires_in: session.expires_in ?? ACCESS_DEFAULT_EXPIRES_IN,
    refresh_token: newRaw,
    scope: row.scope,
    user_id: row.user_id,
    device_id: row.device_id,
    supabase_url: process.env.NEXT_PUBLIC_STORAGE_SUPABASE_URL,
    supabase_anon_key: process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY,
  });
}
