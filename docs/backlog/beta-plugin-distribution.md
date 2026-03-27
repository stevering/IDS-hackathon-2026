# Beta Plugin Distribution for Private Beta Users

## Problem

The Figma plugin is not yet published on the Figma Community. Beta users (non-developers) cannot import a plugin from manifest — they need a way to install the plugin that connects to `preview.guardian.figdesys.com`.

Currently, only developers can test the plugin via `pnpm dev:preview` + manifest import.

## Requirements

1. **Plugin installable by beta users** without cloning the repo or running any build
2. **Plugin points to the preview webapp** (`preview.guardian.figdesys.com`)
3. **Temporal worker deployed** so collabs work without a dev running it locally
4. **No local dev stack needed** for beta users

## Tasks

### 1. Publish plugin as private/org plugin on Figma

- Build the plugin with `pnpm --filter @guardian/figma-desktop-plugin build:preview`
- Add `preview.guardian.figdesys.com` to `allowedDomains` (not just `devAllowedDomains`) so it works in published mode
- Publish on Figma Community as **organization-only** or via Figma's private sharing
- Beta users install from Figma like any other plugin

**Manifest change needed:**
```json
"allowedDomains": [
  "https://preview.guardian.figdesys.com",
  "https://guardian.figdesys.com",
  ...existing domains...
]
```

### 2. Deploy Temporal worker

The worker must run 24/7 connected to Temporal Cloud for collabs to work.

Options:
| Platform | Estimated cost | Notes |
|---|---|---|
| Railway | ~$5/month | Simple deploy, supports long-running processes |
| Fly.io | ~$5/month | Good for always-on workers |
| Google Cloud Run | Pay-per-use | Needs `min-instances=1` for always-on |
| AWS ECS/Fargate | Pay-per-use | More setup, good for production |

The worker needs these env vars:
- `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` (Temporal Cloud)
- `STORAGE_SUPABASE_URL`, `STORAGE_SUPABASE_SERVICE_ROLE_KEY` (Supabase Cloud)
- `AI_GATEWAY_API_KEY` (platform free tier, optional if users have BYOK)

### 3. (Optional) CI/CD for plugin publish

Automate the plugin build + publish on each push to the preview branch:
- `pnpm --filter @guardian/figma-plugin build:preview`
- Upload to Figma via API (if available) or manual publish

## Related

- Presence sync is slow in preview (Supabase Realtime over internet vs localhost) — see `docs/backlog/preview-presence-latency.md`
