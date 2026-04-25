# Electron Overlay — MCP Bridge

The `@guardian/electron-overlay` package runs a small Electron app that:

- Renders the floating overlay UI on the user's desktop (status dot, drag handle, tray icon).
- Hosts the **MCP Bridge**: a long-lived process that connects the user's Supabase session to local MCP servers (Figma Console, GitHub MCP, etc.) so Temporal workflows running in the cloud can reach them via Realtime broadcasts.

This document focuses on the **MCP Bridge** and its session lifecycle. UI details live next to the code in `packages/electron-overlay/src/renderer/`.

## File map

| File | Role |
|---|---|
| `packages/electron-overlay/src/main/mcp-bridge.ts` | Bridge class: Supabase session, Realtime channels, local MCP discovery, heartbeat. |
| `packages/electron-overlay/src/main/index.ts` | Electron entry point; instantiates `GuardianBridge.start()` once a session is loaded. |
| `packages/web/src/app/api/guardian/status/route.ts` | HTTP health endpoint the overlay polls every 30 s to colour the cloud dot. |

## Supabase client constraints (Node / Electron main)

The bridge runs in Electron's main process — Node, no DOM. This breaks several browser-only assumptions of `supabase-js`:

1. **`autoRefreshToken` does nothing without an explicit start.** It relies on `document.visibilitychange`. The bridge calls `await supabase.auth.startAutoRefresh()` after `setSession()` and `await supabase.auth.stopAutoRefresh()` on teardown.
2. **Realtime auth must be re-synced on every refresh.** `supabase.realtime.setAuth(token)` is called once at boot and then again from `onAuthStateChange` on every successful refresh, otherwise the WebSocket eventually disconnects with `auth_expired`.
3. **The Realtime transport must be the `ws` npm package**, not Electron's built-in `WebSocket` (which stalls the handshake).
4. **Channel subscribe order matters.** Subscribe to Realtime channels *before* opening long-lived HTTP/SSE connections to local MCP servers; heavy local socket activity opened first can saturate Electron's network slot and stall the WS upgrade.

## Heartbeat

Every `HEARTBEAT_INTERVAL_MS` (5 s), `publishHeartbeat()` does two things:

1. Calls `touchLastSeen()` — RPC `touch_device_last_seen(p_device_fingerprint)` on Supabase, which updates `user_devices.last_seen_at`. The webapp's REST endpoints (`/api/user/mcp-instances`, `/api/user/devices`) read this column to show whether a device is online.
2. Publishes a `bridge_heartbeat` payload on the Realtime channel, listing the local MCP instances it knows about. Webapp UIs (TargetSelector, Local services panel) listen for this to render live state.

5 s is chosen so that a freshly-mounted webapp hook (e.g. TargetSelector after navigating back) sees the device as online within ~5 s instead of waiting up to 30 s for the next broadcast.

## `touchLastSeen` failure handling

Without guards, a dead session (refresh token revoked, user re-logged in elsewhere, system clock drift) would generate **12 failed RPCs per minute indefinitely**. With local Supabase this saturates Kong's 512 `worker_connections`, which then closes sockets mid-request on unrelated traffic — including the webapp's own login requests. Symptoms in `logs/dev.log`:

```
[mcp-bridge] touch_device_last_seen failed: JWT expired
TypeError: fetch failed [cause]: Error [SocketError]: other side closed
```

The bridge therefore implements two distinct guards:

### 1. Stop-on-auth-error (suspend until next refresh)

If the RPC fails with any of the following, `lastSeenAuthSuspended` is set to `true` and `touchLastSeen()` returns early on subsequent ticks:

- Message contains `jwt expired`, `invalid jwt`, or `auth session missing`.
- `error.code === "PGRST301"` (PostgREST JWT failure).
- `error.status === 401`.

The flag is cleared from `onAuthStateChange` the moment a fresh `session?.access_token` arrives. If the next event is `SIGNED_OUT` or `TOKEN_REFRESHED` *without* a session (refresh failed), the suspension persists.

This prevents 401-spam while waiting for `startAutoRefresh()` to recover (or for the user to re-authenticate via the webapp).

### 2. Exponential back-off (transient errors)

For non-auth errors (network blip, Postgres restart, etc.), the bridge skips RPCs in a growing window:

| Consecutive failures | Next retry after |
|---|---|
| 1 | 5 s |
| 2 | 10 s |
| 3 | 20 s |
| 4 | 40 s |
| 5 | 80 s |
| 6+ | 120 s (cap) |

The counter and window reset on the first successful RPC, with a `recovered` log line.

The Realtime publish in `publishHeartbeat()` still happens on every tick — only the DB RPC is throttled. A device that loses DB connectivity but keeps WS will still appear live in any UI subscribed to the broadcast.

## Known limitation — static `Authorization` header

In the `SupabaseClient` constructor, when `accessToken` is provided, a global header is set:

```ts
global: config.accessToken
  ? { headers: { Authorization: `Bearer ${config.accessToken}` } }
  : undefined,
```

This header is **frozen at construction time**. `startAutoRefresh()` correctly refreshes the session inside `supabase-js`, but the global `Authorization` header is never rewritten — so after the initial token's TTL (~1 h) every authenticated REST call sends an expired token, even though the in-memory session is fresh.

The back-off and suspend logic above prevents the resulting spam, but the proper fix is to either:

- Drop the global header entirely and let `supabase-js` derive the `Authorization` from the session per request, or
- Re-set the global header from `onAuthStateChange` whenever a refreshed session is delivered.

This is tracked separately and not yet implemented.

## BrowserWindow security

The overlay window is created with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. The preload script (`preload/index.ts`) uses `contextBridge.exposeInMainWorld()` to expose a controlled API surface — only IPC handlers for hover state, bridge messages, system status, and panel resize. No direct access to `require()`, `process`, or the filesystem from the renderer.

## Tray-icon and macOS UI gotchas

These are unrelated to the bridge but live in the same package and are useful context when touching the overlay:

- `nativeImage.createEmpty()` crashes on macOS. Use `nativeImage.createFromBuffer(buf, { width: 16, height: 16 })` with an RGBA 16×16 buffer.
- The `mousedown` / `contextmenu` JS events do **not** fire when another app (Figma) is in the foreground on macOS. Use `-webkit-app-region: drag` in CSS for dragging, and `webContents.on('context-menu', ...)` in the main process for the right-click menu.
- Click-through / hover is implemented by polling `screen.getCursorScreenPoint()` every 50 ms in the main process and calling `setIgnoreMouseEvents(!over, { forward: true })`. The `{ forward: true }` is required in **both** branches for macOS to forward clicks to the underlying app when `over === false`.

## Operational notes

- **Running locally vs against preview.** The overlay reads `GUARDIAN_CLOUD_URL` (default `http://localhost:3000`) to decide where to poll `/api/guardian/status` from.
  - `pnpm dev` → overlay points at the local webapp.
  - `pnpm dev:preview` → overlay (and plugins) point at `https://preview.guardian.figdesys.com`. The script aliases `GUARDIAN_CLOUD_URL` onto `GUARDIAN_URL` so a single env controls both targets.
- **Single-instance lock.** If a stale Electron process holds the lock, `requestSingleInstanceLock()` returns `false` and the new instance exits silently after ~1 s. Kill stale processes:
  ```bash
  ps aux | grep "[E]lectron" | grep -v Helper | awk '{print $2}' | xargs kill
  ```
- **Local Kong saturation symptoms.** If `logs/dev.log` shows repeated `TypeError: fetch failed / other side closed` on `127.0.0.1:54321`, check `docker logs supabase_kong_IDS-hackathon-2026 --tail 50` for `worker_connections are not enough`. The first suspect is unbounded retry loops like the one fixed here. Restart Kong with `docker restart supabase_kong_IDS-hackathon-2026` to recover the connection pool.
