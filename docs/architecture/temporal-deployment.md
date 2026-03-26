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

## Files

- `packages/temporal/src/client.ts` — Client factory (API routes)
- `packages/temporal/src/worker.ts` — Worker entry point
- `turbo.json` — Env var declarations for build pipeline
