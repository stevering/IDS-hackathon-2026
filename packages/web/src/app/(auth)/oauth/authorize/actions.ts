"use server";

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { generateAuthCode } from "@/lib/oauth/pkce";
import { isRedirectUriAllowed } from "@/lib/oauth/redirect-uri";

const AUTH_CODE_TTL_MS = 120_000;

type DecisionInput = {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  device_fingerprint?: string;
  device_name?: string;
};

type DecisionResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

function buildRedirect(base: string, params: Record<string, string>): string {
  const joiner = base.includes("?") ? "&" : "?";
  const qs = new URLSearchParams(params).toString();
  return `${base}${joiner}${qs}`;
}

// Returns the redirect URL as a string instead of calling redirect().
// The client component then does window.location.href = url — this is the
// only reliable way to navigate to a non-http scheme (guardian://) because
// Next's own server-action redirect handling doesn't follow custom protocols.
export async function approveAuthorization(input: DecisionInput): Promise<DecisionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated" };

  const admin = createServiceClient();

  const { data: client, error } = await admin
    .from("oauth_clients")
    .select("id, redirect_uris, allowed_scopes, requires_pkce")
    .eq("id", input.client_id)
    .maybeSingle();
  if (error || !client) {
    return { ok: true, url: buildRedirect(input.redirect_uri, { error: "invalid_client", state: input.state }) };
  }
  if (!isRedirectUriAllowed(client.redirect_uris, input.redirect_uri)) {
    return { ok: true, url: buildRedirect(input.redirect_uri, { error: "invalid_request", state: input.state }) };
  }
  if (client.requires_pkce && (!input.code_challenge || input.code_challenge_method !== "S256")) {
    return { ok: true, url: buildRedirect(input.redirect_uri, { error: "invalid_request", state: input.state }) };
  }

  const code = generateAuthCode();
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString();

  const { error: insertErr } = await admin.from("oauth_authorization_codes").insert({
    code,
    client_id: input.client_id,
    user_id: user.id,
    redirect_uri: input.redirect_uri,
    scope: input.scope,
    code_challenge: input.code_challenge,
    code_challenge_method: input.code_challenge_method,
    device_fingerprint: input.device_fingerprint ?? null,
    device_name: input.device_name ?? null,
    expires_at: expiresAt,
  });
  if (insertErr) {
    return { ok: true, url: buildRedirect(input.redirect_uri, { error: "server_error", state: input.state }) };
  }

  return { ok: true, url: buildRedirect(input.redirect_uri, { code, state: input.state }) };
}

export async function denyAuthorization(
  input: Pick<DecisionInput, "redirect_uri" | "state">,
): Promise<DecisionResult> {
  return { ok: true, url: buildRedirect(input.redirect_uri, { error: "access_denied", state: input.state }) };
}
