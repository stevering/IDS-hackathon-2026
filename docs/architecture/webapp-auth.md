# Webapp Auth — Session Cookies, 401 Symptoms & Defenses

This page documents how Supabase auth is wired into the Next.js webapp (`packages/web`), the two distinct failure modes we have observed when API requests return 401 unexpectedly, and the defensive measures in place.

## Setup

| Client | File | Used by |
|---|---|---|
| Browser | `packages/web/src/lib/supabase/client.ts` → `createBrowserClient` | Client Components (`"use client"`) |
| Server | `packages/web/src/lib/supabase/server.ts` → `createServerClient` | Route Handlers, Server Components, Server Actions |
| Middleware | `packages/web/src/proxy.ts` → `createServerClient` | Page-level auth guard, redirects unauthenticated users to `/login` |

Cookies are set with `sameSite: "none"` + `secure: true` (required for iframe embedding in the Figma plugin). No `httpOnly`, so the browser client can read them.

## Failure mode #1 — Kong saturation (CONFIRMED, root cause of the April 19 incident)

### Symptom

Several API routes return **401** in the same page load while others return **200**. In `logs/dev.log`:

```
TypeError: fetch failed
[cause]: Error [SocketError]: other side closed
remoteAddress: 127.0.0.1, remotePort: 54321, bytesWritten: 1346, bytesRead: 0
```

Server-side `getUser()` returns `null` and the route 401s, even though the browser sent a valid `sb-...-auth-token` cookie.

The diagnostic block in `app/api/user/api-keys/route.ts` captures this case:

```
[api-keys 401] diagnostic {
  hasUser: false,
  getUserError: { message: 'fetch failed', status: 0, name: 'AuthRetryableFetchError' },
  cookieCount: 4,
  sbCookies: [ 'sb-127-auth-token' ]
}
```

`AuthRetryableFetchError` is what `@supabase/ssr` raises when the outbound `POST /auth/v1/user` fails at the TCP level. Status `0` means there was no HTTP response at all — Kong closed the socket mid-request.

### Cause

Local Supabase Kong has `worker_connections = 512`. When too many concurrent connections target the upstream services (PostgREST, Auth, Realtime, Storage), Kong logs `worker_connections are not enough, reusing connections` and starts dropping sockets on new requests. We have observed this happen because of:

- A runaway Temporal server crash loop (`interrupted (9)`, `shard status unknown`) that floods Supabase with retries.
- Background pollers left running on stale orchestration IDs (`intercept_queue` long-poll).
- The Electron overlay's `touch_device_last_seen` heartbeat firing 12 times per minute with no back-off when auth is broken (now patched, see `electron-overlay.md`).

### How to detect

```bash
# 1. Are sockets being dropped? (look for fetch failed / other side closed in webapp logs)
grep "remotePort: 54321" logs/dev.log | wc -l

# 2. Is Kong saturating?
docker logs supabase_kong_IDS-hackathon-2026 --since 60s | grep -c "worker_connections"

# 3. What's hammering Kong?
docker logs supabase_kong_IDS-hackathon-2026 --since 30s | grep -v worker_connections \
  | grep -E "GET|POST" | awk -F'"' '{print $2}' | awk '{print $1, $2}' \
  | sort | uniq -c | sort -rn | head
```

A healthy state is **0 worker_connections warnings per minute**. Any non-zero value means a noisy client must be tracked down.

### How to recover

1. Stop the noisy client (kill stale Temporal server, kill the overlay if its heartbeat is misbehaving, terminate fantasy orchestrations).
2. `docker restart supabase_kong_IDS-hackathon-2026` — recycles the connection pool.
3. Verify `auth/v1/health` responds in <50 ms: `curl http://127.0.0.1:54321/auth/v1/health`.

### Caveat about `concurrently -k`

The root `pnpm dev` script uses `concurrently -k`, which means *if any child exits, kill all the others*. So `kill <temporal-server-pid>` will also tear down `next-server`, `mcp-server`, the Electron overlay, etc. To restart Temporal alone, kill **and** relaunch the whole stack with a fresh `pnpm dev`.

## Failure mode #2 — Refresh-token rotation race (THEORETICAL, not yet observed in this codebase)

### Why we worry about it

`@supabase/ssr` applies refresh-token rotation: when an access_token is refreshed, the old refresh_token is invalidated. If a page fires several API requests in parallel and all the access_tokens in their cookies are stale, each handler tries to refresh using the **same** refresh_token. The first wins, the others get `Invalid Refresh Token` → `getUser()` returns null → 401.

The April 19 incident initially looked like this — `settings 200 + api-keys 401 + mcp-instances 200` from the same parallel batch. But the diagnostic capture proved the cause was Kong (mode #1), not rotation. Kong saturation can produce the same patchy pattern.

### Defense in place (precaution)

In `app/(main)/account/page.tsx`, before the `Promise.all` of five fetches, we pre-refresh on the browser client:

```ts
const supabase = createSupabaseBrowserClient();
await supabase.auth.getSession();
```

`getSession()` triggers a refresh if the access_token is stale and posts the new cookies once, synchronously from the browser's POV. Every subsequent `fetch` carries a fresh access_token, so no route handler needs to refresh, so no race is possible.

This is **defense in depth**: it costs ~50 ms per page load and prevents a real, plausible bug. If we ever capture a `[api-keys 401]` diagnostic showing `getUserError: { message: 'Invalid Refresh Token' }` (or similar) instead of `fetch failed`, that will be hard evidence the race actually happens — and the defense will have been justified.

### Why we did *not* add it everywhere

The shell of the chat UI fires many parallel requests on mount (`useGuardianPresence`, `useUserMCPInstances`, conversation loaders, etc.). The same race could happen there. We have not added a global `SessionGate` provider because:

1. The race has not been observed yet in production traces.
2. A global gate would block the whole app render until session refresh completes — a UX cost.
3. We may instead consolidate into a single `/api/user/bootstrap` endpoint that returns all the shell data in one response — that removes the parallelism entirely.

## Other defenses (kept regardless of root cause)

### Don't redirect on a single API 401 (`account/page.tsx`)

The original code did `router.push("/login")` the moment `/api/user/api-keys` returned 401. That meant any transient API failure (Kong blip, rotation race, network hiccup) booted the user out. The middleware (`proxy.ts`) is the authoritative auth gate and will redirect on the next page navigation if the session is truly gone. The page now displays a recoverable error instead.

**Rule for any future page**: never use a single API 401 as a signal to log the user out. Show a retry affordance, surface the error, but trust the middleware for redirects.

### Log silently-swallowed cookie errors (`lib/supabase/server.ts`)

The `setAll` callback used to do `try { … } catch {}` with no logging. That swallowed any cookie-write failure that wasn't an RSC read-only error. It is now `console.debug(..., err)` — keeps the noise low (RSC misses are expected) but surfaces real failures.

## Diagnostic block in `api-keys/route.ts` — keep until next 401

The GET handler logs a `[api-keys 401] diagnostic { ... }` block whenever it returns 401. It captures `tookMs`, the `getUserError`, the cookie count, and the names of `sb-*` cookies. This proved its worth on April 19 and should stay in place until either:

- A new occurrence yields different evidence (e.g. an `Invalid Refresh Token` payload, confirming the rotation race exists in our setup).
- We have gone several weeks with no 401 captures, in which case the block can be removed and re-added if needed.

## File map

- `packages/web/src/proxy.ts` — middleware auth guard.
- `packages/web/src/lib/supabase/server.ts` — server client factory; logged `setAll` catch.
- `packages/web/src/lib/supabase/client.ts` — browser client factory.
- `packages/web/src/app/(main)/account/page.tsx` — pre-refresh + non-redirecting 401 handler.
- `packages/web/src/app/api/user/api-keys/route.ts` — diagnostic block on 401.
