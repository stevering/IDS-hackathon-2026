# Temporal Deployment — Local vs Cloud

How the Temporal connection is configured for local development and Temporal Cloud (preprod/prod).

## Connection Modes

The connection mode is auto-detected from environment variables. No code changes needed between environments.

| Mode | Detection | TLS | Auth |
|---|---|---|---|
| **Local dev** | No `TEMPORAL_API_KEY` or `TEMPORAL_CLIENT_CERT_BASE64` | None | None |
| **Cloud (API key)** | `TEMPORAL_API_KEY` is set | Enabled | API key header |
| **Cloud (mTLS)** | `TEMPORAL_CLIENT_CERT_BASE64` + `TEMPORAL_CLIENT_KEY_BASE64` set | mTLS | Client certificate |

API key takes precedence over mTLS if both are set.

## Environment Variables

### Common (all modes)

| Variable | Default | Description |
|---|---|---|
| `TEMPORAL_ADDRESS` | `localhost:7233` | gRPC endpoint |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TASK_QUEUE` | `guardian-orchestration` | Worker task queue |
| `TEMPORAL_ENABLED` | — | Feature flag (backend) |
| `NEXT_PUBLIC_TEMPORAL_ENABLED` | — | Feature flag (frontend) |

### Cloud — API key auth (recommended)

| Variable | Description |
|---|---|
| `TEMPORAL_API_KEY` | Temporal Cloud API key |

### Cloud — mTLS auth (alternative)

| Variable | Description |
|---|---|
| `TEMPORAL_CLIENT_CERT_BASE64` | Base64-encoded PEM client certificate |
| `TEMPORAL_CLIENT_KEY_BASE64` | Base64-encoded PEM client private key |

Base64 encoding is used so certificates can be stored as Vercel env vars (no file system access needed).

To encode a certificate: `base64 -i client.pem`

## Architecture — Preprod / Prod

```
Vercel (packages/web)                    Temporal Cloud
┌──────────────────────┐                ┌──────────────────┐
│ Next.js API routes   │──── gRPC+TLS ──│ Temporal Server  │
│ /api/orchestration/* │                │ (hosted)         │
└──────────────────────┘                └────────┬─────────┘
                                                 │
                                        task queue polling
                                                 │
                                        ┌────────┴─────────┐
                                        │ Temporal Worker   │
                                        │ (long-lived host) │
                                        └──────────────────┘
```

- **API routes** (Vercel serverless) use `@temporalio/client` to start/signal/query workflows.
- **Worker** must run on a persistent host (not Vercel serverless) — it long-polls the task queue.
- Both use the same env vars and auto-detect the connection mode.

## Preview Worker — Railway

The preview environment worker runs on **Railway** (Amsterdam, `eu-west`).

- **Project**: `guardian` → Environment: `preview`
- **Service**: `temporal-worker`
- **Dockerfile**: `packages/temporal/Dockerfile`
- **Branch**: `feat/preview` (auto-deploy on push)
- **Env vars**: Temporal Cloud + Supabase Cloud + `NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY` (required for Realtime broadcasts)

The Dockerfile installs `ca-certificates` (required for TLS to Temporal Cloud on `node:22-slim`).

### Supabase Realtime — anon key requirement

Broadcasts to the plugin (e.g., `connect_fc_cloud_relay`, `connect_fc_port`) must use the **anon key**, not the service-role key. Supabase Cloud Realtime rejects service-role WebSocket connections with `CHANNEL_ERROR`.

## MCP OAuth

The MCP server on Vercel (`/api/mcp`) supports OAuth 2.0 for external clients (e.g., Claude Code):

- `/.well-known/oauth-authorization-server` — RFC 8414 metadata
- `/.well-known/oauth-protected-resource/api/mcp` — RFC 9728 resource metadata
- `/api/mcp/oauth/authorize` — proxies to Supabase OAuth
- `/api/mcp/oauth/token` — proxies to Supabase OAuth
- `/api/mcp/oauth/register` — proxies to Supabase Dynamic Client Registration

All OAuth endpoints proxy to Supabase Auth (`/auth/v1/oauth/*`) with the `apikey` header injected. The MCP route returns 401 with `WWW-Authenticate` header when no valid Bearer token is provided.

## Files

- `packages/temporal/src/client.ts` — Client factory (API routes)
- `packages/temporal/src/worker.ts` — Worker entry point
- `packages/temporal/Dockerfile` — Railway deployment
- `packages/web/src/lib/mcp-oauth.ts` — OAuth helpers
- `packages/web/src/app/api/mcp/oauth/` — OAuth proxy routes
- `packages/web/src/app/.well-known/` — Discovery endpoints
- `turbo.json` — Env var declarations for build pipeline
