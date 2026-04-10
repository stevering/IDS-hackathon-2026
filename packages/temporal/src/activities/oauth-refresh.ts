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
  /**
   * Internal field (not from OAuth server) used to carry DCR-registered
   * client credentials from callback to worker. Set by OAuth callbacks that
   * use Dynamic Client Registration (Southleft, future Figma MCP rework).
   */
  _guardian_client_info?: {
    client_id?: string;
    client_secret?: string;
  };
  [key: string]: unknown;
};

/**
 * Per-provider refresh configuration (from BUILTIN_PRESETS or user-supplied).
 * Either `tokenEndpoint` (explicit) or `discoveryUrl` (for RFC 8414 discovery)
 * must be provided.
 */
export type OAuthRefreshConfig = {
  /** Direct token endpoint (e.g. GitHub's). */
  tokenEndpoint?: string;
  /**
   * Base URL of the OAuth server for RFC 8414 discovery.
   * token_endpoint is fetched from `<discoveryUrl>/.well-known/oauth-authorization-server`.
   * Used by Figma MCP (mcp.figma.com) which publishes its metadata dynamically.
   */
  discoveryUrl?: string;
  clientId: string;
  /** Omit for public clients (PKCE only). */
  clientSecret?: string;
};

// ---------------------------------------------------------------------------
// RFC 8414 token endpoint discovery (cached per worker process)
// ---------------------------------------------------------------------------

const tokenEndpointCache = new Map<string, string>();

/**
 * Discover the OAuth 2.0 token endpoint from a server's well-known metadata.
 * Tries both OAuth 2.0 Authorization Server Metadata (RFC 8414) and OpenID
 * Connect discovery as fallback.
 */
export async function discoverTokenEndpoint(baseUrl: string): Promise<string | null> {
  const trimmed = baseUrl.replace(/\/$/, "");
  const cached = tokenEndpointCache.get(trimmed);
  if (cached) return cached;

  const candidates = [
    `${trimmed}/.well-known/oauth-authorization-server`,
    `${trimmed}/.well-known/openid-configuration`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const meta = (await res.json()) as { token_endpoint?: unknown };
      if (typeof meta.token_endpoint === "string" && meta.token_endpoint.length > 0) {
        tokenEndpointCache.set(trimmed, meta.token_endpoint);
        log.info(`Discovered token endpoint for ${trimmed}: ${meta.token_endpoint}`);
        return meta.token_endpoint;
      }
    } catch {
      // Try next candidate
    }
  }

  log.warn(`Could not discover token endpoint from ${trimmed}`);
  return null;
}

/** Resolve the token endpoint from config — explicit or discovered. */
async function resolveTokenEndpoint(config: OAuthRefreshConfig): Promise<string | null> {
  if (config.tokenEndpoint) return config.tokenEndpoint;
  if (config.discoveryUrl) return discoverTokenEndpoint(config.discoveryUrl);
  return null;
}

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
  const tokenEndpoint = await resolveTokenEndpoint(config);
  if (!tokenEndpoint) {
    throw new Error(
      `No token endpoint available (neither explicit nor discoverable from ${config.discoveryUrl ?? "<none>"})`,
    );
  }

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", config.clientId);
  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret);
  }

  const res = await fetch(tokenEndpoint, {
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
      `Refresh failed ${res.status} at ${tokenEndpoint}: ${text.slice(0, 200)}`,
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
// Reactive refresh — force refresh ignoring expires_at (for 401 retry paths)
// ---------------------------------------------------------------------------

/**
 * Unconditionally refresh the stored tokens, regardless of expires_at.
 * Used as a last-resort retry when an API returns 401 despite the token
 * appearing still valid (e.g., Figma's expires_in sometimes lies, or the
 * provider rotated/revoked the token out-of-band).
 *
 * Returns the fresh tokens on success, or null if refresh is impossible
 * (no refresh_token, no config, or HTTP error).
 */
export async function forceRefreshOAuthToken(params: {
  supabase: SupabaseClient;
  userId: string;
  serverId: string;
  currentTokens: StoredTokens;
  refreshConfig?: OAuthRefreshConfig;
  scopes?: string;
}): Promise<StoredTokens | null> {
  const refreshToken = params.currentTokens.refresh_token;
  if (!refreshToken) {
    log.warn(`No refresh_token for ${params.serverId} — cannot force refresh`);
    return null;
  }
  if (!params.refreshConfig) {
    log.warn(`No refresh config for ${params.serverId} — cannot force refresh`);
    return null;
  }

  log.info(`Force-refreshing ${params.serverId} token (reactive path, bypassing expires_at)`);

  let newTokens: StoredTokens;
  try {
    newTokens = await refreshOAuthToken(refreshToken, params.refreshConfig);
  } catch (err) {
    log.error(`Force refresh failed for ${params.serverId}`, { error: String(err) });
    return null;
  }

  if (!newTokens.refresh_token) {
    newTokens.refresh_token = refreshToken;
  }

  const expiresInSec = typeof newTokens.expires_in === "number" ? newTokens.expires_in : null;
  const newExpiresAt =
    expiresInSec != null ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null;

  const { error: upsertErr } = await params.supabase.rpc("upsert_mcp_connection_service", {
    p_user_id: params.userId,
    p_server_id: params.serverId,
    p_tokens_json: JSON.stringify(newTokens),
    p_scopes: params.scopes ?? null,
    p_expires_at: newExpiresAt,
  });

  if (upsertErr) {
    log.error(`Failed to persist force-refreshed tokens`, { error: upsertErr.message });
  } else {
    log.info(`${params.serverId} token force-refreshed successfully, new expiry: ${newExpiresAt}`);
  }

  return newTokens;
}

// ---------------------------------------------------------------------------
// Helper: resolve refresh config from a BUILTIN_PRESETS entry
// ---------------------------------------------------------------------------

/**
 * Partial refresh config — may be missing clientId/clientSecret if they come
 * from per-user DCR registration instead of global env vars. Call
 * `completeRefreshConfig(partial, storedTokens)` to resolve the final creds.
 */
export type PartialRefreshConfig = {
  tokenEndpoint?: string;
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string;
};

export function resolveRefreshConfigFromPreset(preset: {
  oauth_token_endpoint?: string;
  oauth_discovery_url?: string;
  oauth_client_id_env?: string;
  oauth_client_secret_env?: string;
}): PartialRefreshConfig | undefined {
  // Need either an explicit endpoint or a discovery URL
  if (!preset.oauth_token_endpoint && !preset.oauth_discovery_url) return undefined;

  const clientId = preset.oauth_client_id_env
    ? process.env[preset.oauth_client_id_env]
    : undefined;
  const clientSecret = preset.oauth_client_secret_env
    ? process.env[preset.oauth_client_secret_env]
    : undefined;

  return {
    tokenEndpoint: preset.oauth_token_endpoint,
    discoveryUrl: preset.oauth_discovery_url,
    clientId,
    clientSecret,
  };
}

/**
 * Given a partial config (from preset) and stored tokens, produce the final
 * OAuthRefreshConfig by filling in missing credentials from the stored
 * `_guardian_client_info` field (set by DCR-aware callbacks).
 *
 * Silent — returns undefined without logging. Callers decide whether a missing
 * config is noteworthy (e.g. `refreshOAuthTokenIfNeeded` only logs when a
 * refresh is actually needed).
 */
export function completeRefreshConfig(
  partial: PartialRefreshConfig | undefined,
  storedTokens: StoredTokens,
): OAuthRefreshConfig | undefined {
  if (!partial) return undefined;
  if (!partial.tokenEndpoint && !partial.discoveryUrl) return undefined;

  let clientId = partial.clientId;
  let clientSecret = partial.clientSecret;

  // Fill from stored DCR client_info if env credentials are missing
  const storedInfo = storedTokens._guardian_client_info;
  if (storedInfo) {
    if (!clientId && typeof storedInfo.client_id === "string") {
      clientId = storedInfo.client_id;
    }
    if (!clientSecret && typeof storedInfo.client_secret === "string") {
      clientSecret = storedInfo.client_secret;
    }
  }

  if (!clientId) return undefined;

  return {
    tokenEndpoint: partial.tokenEndpoint,
    discoveryUrl: partial.discoveryUrl,
    clientId,
    clientSecret,
  };
}
