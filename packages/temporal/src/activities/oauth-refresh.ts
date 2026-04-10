/**
 * Generic OAuth2 refresh_token flow (RFC 6749 §6).
 *
 * Provider-agnostic: works for any OAuth2 server that issues refresh_token
 * and exposes a token endpoint accepting the `refresh_token` grant type.
 * Used today by GitHub (8h tokens). Ready for Figma / Figma Console if they
 * ever shorten their 90-day lifetime, and for user-added custom MCP servers (v2).
 *
 * The only things that vary per provider:
 *   - tokenEndpoint URL (e.g. https://github.com/login/oauth/access_token)
 *   - clientId (always required)
 *   - clientSecret (confidential clients only; public/PKCE clients omit)
 *   - Whether refresh_token rotates (GitHub yes, some providers no)
 *
 * This module handles all those cases uniformly.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "../lib/log.js";

const log = createLogger("oauth-refresh");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** RFC 6749 standard token response shape. Extra fields are preserved. */
export type StoredTokens = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  [key: string]: unknown;
};

/** Per-provider refresh configuration (from BUILTIN_PRESETS or user-supplied). */
export type OAuthRefreshConfig = {
  tokenEndpoint: string;
  clientId: string;
  /** Omit for public clients (PKCE only). */
  clientSecret?: string;
};

export type RefreshResult =
  | { refreshed: false; tokens: StoredTokens }
  | { refreshed: true; tokens: StoredTokens; newExpiresAt: string };

// ---------------------------------------------------------------------------
// Helper: is the token close to expiration?
// ---------------------------------------------------------------------------

/** Margin before real expiry at which we consider the token "expiring soon". */
const DEFAULT_MARGIN_SECONDS = 60;

function isExpiringSoon(
  expiresAt: Date | null,
  marginSeconds: number,
): boolean {
  if (!expiresAt) return false; // no known expiry → don't refresh
  const expiresMs = expiresAt.getTime();
  const nowMs = Date.now();
  const remainingMs = expiresMs - nowMs;
  return remainingMs < marginSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Core: refresh via RFC 6749 §6
// ---------------------------------------------------------------------------

/**
 * Perform the refresh_token grant request to the provider's token endpoint.
 * Throws on HTTP error or missing access_token in response.
 */
export async function refreshOAuthToken(
  refreshToken: string,
  config: OAuthRefreshConfig,
): Promise<StoredTokens> {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", config.clientId);
  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret);
  }

  const res = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Refresh failed ${res.status} at ${config.tokenEndpoint}: ${text.slice(0, 200)}`,
    );
  }

  // Some providers return form-encoded even with Accept: application/json.
  // Parse both shapes.
  const ct = res.headers.get("content-type") ?? "";
  let parsed: Record<string, unknown>;
  if (ct.includes("application/json")) {
    parsed = await res.json();
  } else {
    const text = await res.text();
    parsed = Object.fromEntries(new URLSearchParams(text).entries());
  }

  if (typeof parsed.access_token !== "string") {
    throw new Error(
      `Refresh response missing access_token: ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }

  // expires_in may come as string from form-encoded, normalize
  if (typeof parsed.expires_in === "string") {
    parsed.expires_in = Number(parsed.expires_in);
  }

  return parsed as StoredTokens;
}

// ---------------------------------------------------------------------------
// High-level: check expiry → refresh → persist → return fresh tokens
// ---------------------------------------------------------------------------

/**
 * Returns fresh (non-expiring-soon) tokens.
 * If currentTokens is not expiring soon → returns them unchanged.
 * If expiring soon AND a refresh_token is present AND refreshConfig is provided
 * → refreshes via RFC 6749, persists new tokens to the Vault, returns them.
 * If refresh is not possible (no refresh_token, no config) → returns current tokens
 * (caller will hit 401 and must prompt user to re-auth).
 */
export async function refreshOAuthTokenIfNeeded(params: {
  supabase: SupabaseClient;
  userId: string;
  /** Matches user_mcp_connections.server_id — used to persist the new tokens. */
  serverId: string;
  /** Current tokens decrypted from Vault. */
  currentTokens: StoredTokens;
  /** Current expiration from user_mcp_connections.expires_at, or null if unknown. */
  expiresAt: Date | null;
  /** Provider-specific refresh config. Omit to skip refresh entirely. */
  refreshConfig?: OAuthRefreshConfig;
  /** Seconds before expiration to start refreshing. Default 60. */
  marginSeconds?: number;
  /** Scopes to pass through when calling upsert_mcp_connection. */
  scopes?: string;
}): Promise<RefreshResult> {
  const margin = params.marginSeconds ?? DEFAULT_MARGIN_SECONDS;

  // Fast path: token is fine
  if (!isExpiringSoon(params.expiresAt, margin)) {
    return { refreshed: false, tokens: params.currentTokens };
  }

  // Can we refresh?
  const refreshToken = params.currentTokens.refresh_token;
  if (!refreshToken) {
    log.warn(`No refresh_token in stored tokens for ${params.serverId} — cannot auto-refresh`);
    return { refreshed: false, tokens: params.currentTokens };
  }
  if (!params.refreshConfig) {
    log.warn(`No refresh config for ${params.serverId} — cannot auto-refresh`);
    return { refreshed: false, tokens: params.currentTokens };
  }

  log.info(`Refreshing ${params.serverId} token (expires ${params.expiresAt?.toISOString()})`);

  let newTokens: StoredTokens;
  try {
    newTokens = await refreshOAuthToken(refreshToken, params.refreshConfig);
  } catch (err) {
    log.error(`Refresh failed for ${params.serverId}`, { error: String(err) });
    return { refreshed: false, tokens: params.currentTokens };
  }

  // Some providers (GitHub) rotate the refresh_token. Others don't.
  // If the response omits refresh_token, preserve the previous one.
  if (!newTokens.refresh_token) {
    newTokens.refresh_token = refreshToken;
  }

  // Compute new expires_at
  const expiresInSec = typeof newTokens.expires_in === "number" ? newTokens.expires_in : null;
  const newExpiresAt =
    expiresInSec != null ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null;

  // Persist to Vault via the existing RPC
  const { error: upsertErr } = await params.supabase.rpc("upsert_mcp_connection_service", {
    p_user_id: params.userId,
    p_server_id: params.serverId,
    p_tokens_json: JSON.stringify(newTokens),
    p_scopes: params.scopes ?? null,
    p_expires_at: newExpiresAt,
  });

  if (upsertErr) {
    log.error(`Failed to persist refreshed tokens`, { error: upsertErr.message });
    // Still return the new tokens — at least this workflow can use them.
  } else {
    log.info(`${params.serverId} token refreshed successfully, new expiry: ${newExpiresAt}`);
  }

  return {
    refreshed: true,
    tokens: newTokens,
    newExpiresAt: newExpiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helper: resolve refresh config from a BUILTIN_PRESETS entry
// ---------------------------------------------------------------------------

export function resolveRefreshConfigFromPreset(preset: {
  oauth_token_endpoint?: string;
  oauth_client_id_env?: string;
  oauth_client_secret_env?: string;
}): OAuthRefreshConfig | undefined {
  if (!preset.oauth_token_endpoint) return undefined;
  if (!preset.oauth_client_id_env) return undefined;

  const clientId = process.env[preset.oauth_client_id_env];
  if (!clientId) {
    log.warn(`Missing env var ${preset.oauth_client_id_env} — cannot refresh`);
    return undefined;
  }

  const clientSecret = preset.oauth_client_secret_env
    ? process.env[preset.oauth_client_secret_env]
    : undefined;

  return {
    tokenEndpoint: preset.oauth_token_endpoint,
    clientId,
    clientSecret,
  };
}
