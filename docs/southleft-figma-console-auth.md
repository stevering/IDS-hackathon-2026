# SouthLeft Figma Console MCP — Authentication Architecture

## Overview

The SouthLeft Figma Console MCP server (`https://figma-console-mcp.southleft.com`) exposes two transport endpoints with fundamentally different authentication models. Guardian must use the correct one to avoid a broken auth flow.

## The Two Endpoints

### `/mcp` (Stateless HTTP — recommended)

- **Transport:** HTTP Streamable
- **Auth model:** The Bearer token from the OAuth flow IS the Figma access token. The server uses it directly for Figma REST API calls.
- **No session state:** No Durable Objects, no KV lookup for `oauth_token:*`. Each request is self-contained.
- **Flow:**
  1. Guardian sends `Authorization: Bearer figu_...` on every HTTP request
  2. SouthLeft validates the token via `bearer_token:<token>` in KV
  3. SouthLeft creates `new FigmaAPI({ accessToken: bearerToken })` directly
  4. Tool calls (e.g. `figma_get_file_data`) use this token for Figma REST API

### `/sse` (Stateful SSE — legacy, problematic)

- **Transport:** Server-Sent Events
- **Auth model:** Two-level authentication — the Bearer token only grants SSE access, but Figma REST API calls require a separate token stored in Cloudflare KV under a fixed session ID.
- **Session state:** Uses Durable Objects with a fixed session ID (`figma-console-mcp-default-session`).
- **Flow:**
  1. Guardian sends `Authorization: Bearer figu_...` on SSE connect
  2. SouthLeft validates token via `bearer_token:<token>` in KV (transport-level auth)
  3. Tool calls invoke `getFigmaAPI()` which looks up `oauth_token:figma-console-mcp-default-session` in KV
  4. If this KV entry has expired or was never populated → returns `authentication_required` with an `auth_url`
  5. User must open `auth_url` in browser to complete a **second** OAuth flow

## Why `/sse` Breaks

The OAuth callback (`/oauth/callback`) stores the Figma token under both:
- `oauth_token:<clientId>` (e.g. `oauth_token:mcp_984abbc4146121ff`)
- `oauth_token:figma-console-mcp-default-session` (fixed key for Durable Objects)

Both entries have a TTL matching the Figma token's `expires_in`. Once the KV entry expires, `getFigmaAPI()` no longer finds a token and returns `authentication_required` — even though the Bearer token on the SSE connection is still valid and could be used directly.

This is a design issue in the `/sse` endpoint: it doesn't reuse the Bearer token for REST API calls, unlike `/mcp` which does.

## Guardian Configuration

In `packages/web/src/app/api/chat/route.ts`:

```typescript
// Use /mcp (stateless) — NOT /sse (stateful with broken double-auth)
const figmaConsoleMcpUrl = `${SOUTHLEFT_MCP_URL}/mcp`;
```

The `detectTransport()` helper returns `"http"` for `/mcp` URLs, and `@ai-sdk/mcp`'s `createMCPClient` handles HTTP transport with `authProvider` natively.

## Token Lifecycle

| Token | Source | Lifetime | Used for |
|-------|--------|----------|----------|
| `figu_...` (access token) | SouthLeft OAuth → Figma OAuth | ~90 days (from `expires_in`) | SSE/HTTP transport auth + Figma REST API (on `/mcp` only) |
| `figur_...` (refresh token) | SouthLeft OAuth → Figma OAuth | Long-lived | Refreshing the access token |

Tokens are stored in Guardian as:
- **Cookie:** `southleft_mcp_tokens` (httpOnly, 90 days)
- **localStorage:** `southleft_access_token` (for browser-side checks)

## Debugging Checklist

If `figmaconsole_figma_get_file_data` returns `authentication_required`:

1. **Check the endpoint** — must be `/mcp`, not `/sse`
2. **Check the token** — `curl -H "Authorization: Bearer figu_..." https://api.figma.com/v1/me` should return 200 (scope error is OK, means token is valid)
3. **If token is invalid (403)** — user needs to re-authenticate via "Sign in with Figma Console"
4. **If using `/sse` and token is valid** — this is the double-auth issue; switch to `/mcp`
