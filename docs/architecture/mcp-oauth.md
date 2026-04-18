# MCP OAuth — Guardian MCP Authentication

## Overview

Guardian MCP (`packages/mcp`) runs as a standalone HTTP server on `127.0.0.1:3847/mcp` (local dev) and enforces Supabase JWT auth on every request. External MCP clients (Claude Code, VS Code, Cursor, etc.) authenticate via the **OAuth 2.1 flow described by the MCP spec revision 2025-06-18 (RFC 9728 Protected Resource Metadata)**. The Temporal worker and the webapp bypass OAuth by presenting the Supabase `service_role` key directly with an `X-Guardian-User-Id` header.

## Local vs Production Differences

| Aspect | Local (Docker) | Production (Supabase Dashboard) |
|---|---|---|
| **OAuth server enabled** | `supabase/config.toml` → `[auth.oauth_server] enabled = true` | Authentication > Settings → OAuth server toggle |
| **Dynamic Client Registration** | `supabase/config.toml` → `allow_dynamic_registration = true` | Authentication > Settings → DCR toggle |
| **Redirect allow-list** | `supabase/config.toml` → `additional_redirect_urls` (glob patterns) | Authentication > URL Configuration > Redirect URLs |
| **Required patterns** | `http://localhost:*`, `http://localhost:*/**`, `http://127.0.0.1:*`, `http://127.0.0.1:*/**` | Same + the Vercel prod webapp domain(s) |
| **MCP server URL** | `http://127.0.0.1:3847/mcp` | Prod URL set via `GUARDIAN_MCP_URL` env var |

`supabase/config.toml` is **local-only**: it drives the Docker containers started by `supabase start`. It is not pushed to the cloud project (`ookghxkvzdnqicjdslej`). Cloud OAuth settings must be mirrored manually in the Supabase Dashboard.

## Client auth flow (Claude Code, 2025-06-18+ spec)

```
Claude Code                       Guardian MCP (:3847)              Supabase gotrue (:54321)
    │                                    │                                    │
    │ POST /mcp                          │                                    │
    ├───────────────────────────────────►│                                    │
    │                                    │                                    │
    │ 401 + WWW-Authenticate:            │                                    │
    │   Bearer resource_metadata="…"     │                                    │
    │◄───────────────────────────────────┤                                    │
    │                                    │                                    │
    │ GET /.well-known/                  │                                    │
    │   oauth-protected-resource         │                                    │
    ├───────────────────────────────────►│                                    │
    │ 200 {resource, authorization_      │                                    │
    │   servers:["http://…:3847"]}       │                                    │
    │◄───────────────────────────────────┤                                    │
    │                                    │                                    │
    │ GET /.well-known/                  │                                    │
    │   oauth-authorization-server       │                                    │
    ├───────────────────────────────────►│                                    │
    │ 200 {authorize,token,register…}    │                                    │
    │◄───────────────────────────────────┤                                    │
    │                                    │                                    │
    │ POST /oauth/register               │   POST /oauth/clients/register     │
    │   (DCR — dynamic client)           │   (proxy + apikey injection)       │
    ├───────────────────────────────────►├───────────────────────────────────►│
    │◄───────────────────────────────────│◄───────────────────────────────────│
    │                                    │                                    │
    │ GET /oauth/authorize?…             │ → 302 to gotrue /oauth/authorize   │
    ├───────────────────────────────────►├───────────────────────────────────►│
    │                                    │                                    │
    │    browser → /oauth/consent (webapp /oauth/consent page)                │
    │    user clicks Authorize                                                │
    │                                    │                                    │
    │ GET http://localhost:<port>/cb?    │                                    │
    │   code=… &state=…                  │                                    │
    │◄───────────────────────────────────┤                                    │
    │                                    │                                    │
    │ POST /oauth/token (PKCE exchange)  │   POST /oauth/token                │
    ├───────────────────────────────────►├───────────────────────────────────►│
    │◄───────────────────────────────────│◄───────────────────────────────────│
    │                                    │                                    │
    │ GET /mcp  +  Authorization: Bearer <access_token>                       │
    ├───────────────────────────────────►│   verify JWT against Supabase JWKS │
    │                                    ├───────────────────────────────────►│
    │                                    │◄───────────────────────────────────│
    │ 200 — MCP session established      │                                    │
    │◄───────────────────────────────────┤                                    │
```

## Implementation

### MCP server (`packages/mcp/src/`)

| File | Role |
|---|---|
| `auth.ts` | `buildOAuthMetadata`, `handleOAuthDiscovery` (RFC 8414) — authorization server discovery |
| | `buildProtectedResourceMetadata`, `handleProtectedResourceMetadata` (RFC 9728) — protected resource discovery, required by MCP 2025-06-18+ |
| | `handleOAuthProxy` — forwards `/oauth/{register,authorize,token,userinfo}` to Supabase gotrue with `apikey` header |
| | `verifyRequest` — validates Bearer JWT against Supabase JWKS (or accepts `service_role` key as internal bypass) |
| | `send401` — emits `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"` |
| `index.ts` | HTTP dispatcher — routes `/health`, `/.well-known/*`, `/oauth/*`, `/mcp` |

### Webapp (`packages/web/src/app/`)

| Path | Role |
|---|---|
| `.well-known/oauth-protected-resource/api/mcp/route.ts` | PRM for the webapp's own MCP endpoint at `/api/mcp` |
| `api/mcp/oauth/{register,authorize,token}/route.ts` | OAuth proxy (mirrors the standalone MCP server's proxy logic) |
| `oauth/consent/page.tsx` | User-facing consent UI — calls `supabase.auth.oauth.getAuthorizationDetails()` then approve/deny |
| `lib/mcp-oauth.ts` | Shared proxy helpers |

### Two separate MCP entry points

1. **Standalone MCP server** on port 3847 — used by Claude Code, Cursor, other desktop MCP clients; configured in `.mcp.json`.
2. **Webapp MCP route** at `/api/mcp` — used by the Guardian webapp's own chat UI (same Supabase project, same OAuth flow).

Both implement the full RFC 9728 PRM surface.

## Why this broke

1. Commit `35e17ad` (2026-03-26) introduced `[auth.oauth_server]` with `enabled = false` and `allow_dynamic_registration = false` in `config.toml`. This silently disabled the OAuth server, but Claude Code continued to work for ~7 more days using cached OAuth refresh tokens.
2. When the refresh token expired, Claude Code re-ran the discovery flow and hit two issues:
   - The `WWW-Authenticate` header in `send401` was pointing `resource_metadata` at the Supabase issuer URL (`http://127.0.0.1:54321/auth/v1`) instead of at the MCP server's own PRM endpoint — which didn't exist at all.
   - Even after fixing the header, DCR returned 404 because the gotrue OAuth server was still disabled.
3. After enabling the OAuth server, the Origin check on `/oauth/authorizations/<id>` (called from the consent page) rejected the webapp's origin `http://127.0.0.1:3000` because the `additional_redirect_urls` allow-list contained only `https://127.0.0.1:3000` (wrong scheme) and `http://127.0.0.1:3000/auth/callback` (specific path).

The current implementation addresses all three root causes.

## Deploy parity checklist (when syncing to cloud)

In the Supabase Dashboard for project `ookghxkvzdnqicjdslej`:

- [ ] **Authentication > Settings > OAuth server**: enabled ✅, DCR allowed ✅
- [ ] **Authentication > URL Configuration > Redirect URLs**: add `http://localhost:*`, `http://localhost:*/**`, `http://127.0.0.1:*`, `http://127.0.0.1:*/**`, and the Vercel prod webapp domain(s). The bare `*` forms (no `/**`) are required because browsers send the Origin header without a trailing slash on CORS fetches.
- [ ] **Deploy** the MCP server to its prod host (the Next.js webapp exposes its own MCP at `/api/mcp`, so this may be sufficient without a standalone deployment of `packages/mcp`)
- [ ] Users set `GUARDIAN_MCP_URL` to the prod URL in their `.mcp.json`

Loopback wildcards in the prod allow-list are safe per **RFC 8252 §7.3** — loopback callbacks are not reachable remotely, so there's no risk of code exfiltration to a third party.
