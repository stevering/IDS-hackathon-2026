# Preview Presence Latency

## Problem

When using `pnpm dev:preview`, the Figma plugin and the Chrome tab take a long time to see each other as connected clients. The connection is slow and chaotic — sometimes requiring navigating to the Account page and back before clients appear.

In local dev (`pnpm dev`), presence sync is near-instant.

## Root Cause

Supabase Realtime Presence goes over the internet (Supabase Cloud) instead of localhost. The latency of `channel.track()` + `presence.sync` is significantly higher.

Additionally, the plugin iframe is a cross-origin context (Figma Desktop embedding `preview.guardian.figdesys.com`), which may add overhead to the WebSocket connection.

## Possible Fixes

- **Shorter keepalive interval**: currently 30s (`PRESENCE_KEEPALIVE_MS`), could be reduced to 10s for preview
- **Immediate re-track on visibility change**: already implemented but may not fire reliably in Figma iframes
- **Fallback polling**: if Realtime presence doesn't sync within N seconds, fall back to polling `/api/clients` endpoint
- **Optimistic UI**: show the plugin as "connecting..." immediately instead of waiting for presence sync

## Files

- `packages/web/src/app/hooks/useFigmaExecuteChannel.ts` — presence tracking
- `packages/web/src/components/ConnectedClients.tsx` — UI display
