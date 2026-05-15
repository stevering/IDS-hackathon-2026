# Web routing

The Guardian webapp (`packages/web`, Next.js 16 App Router) exposes a small, mostly-static map of routes plus a single SPA-style chat surface that the URL now reflects.

## Route map

| Path | File | Description |
|---|---|---|
| `/` | `app/page.tsx` | **Server Component** — `redirect('/chat')`. No React tree mounts at `/`, eliminating the double-mount that used to happen when `Home` first rendered at `/` and then again at `/chat/<id>`. |
| `/chat` and `/chat/<uuid>` | `app/chat/[[...id]]/page.tsx` → `_home.tsx` | **Optional catch-all** route. `/chat` (no segment) is welcome / fresh-chat mode; `/chat/<uuid>` is a specific conversation. The page file is a thin wrapper that imports `_home.tsx` (segment-private, `_` prefix keeps it out of the routing surface). `useParams().id` is `string[] \| undefined`; we take `id[0]`. Works equally for chats and orchestration sub-conversations. |
| `app/chat/layout.tsx` | `app/chat/layout.tsx` | **Shell layout**, mounted once per chat session and never remounted on `/chat` ↔ `/chat/<id>` navigation. Hosts the Figma plugin bridge, the execute channel, the client registry, the conversation list, the MCP instances, the sidebar and the sidebar UI state. The state survives sibling navigation, eliminating the 250-400 ms sidebar flicker that used to happen on every URL flip. See [`chat-state-architecture.md`](./chat-state-architecture.md). |
| `/login`, `/signup`, `/signup/complete`, `/auth/callback`, `/oauth/authorize`, `/oauth/consent`, `/privacy` | `app/(auth)/*`, `app/auth/*`, `app/oauth/*`, `app/privacy/*` | Public pages (listed in `PUBLIC_PAGES` of `src/proxy.ts`). |
| `/account` | `app/(main)/account/page.tsx` | BYOK keys, usage, developer toggles. |
| `/install` | `app/(main)/install/page.tsx` | Plugin / overlay install screen. |
| `/admin/invite` | `app/admin/invite/page.tsx` | Admin-only (gated by `user_metadata.is_admin`). |
| `/api/*` | `app/api/**` | REST + SSE endpoints. Bypassed by the page-level auth guard; individual routes enforce auth themselves. |

## How the chat URL stays in sync with state

Two chat URLs (`/chat` and `/chat/<uuid>`) resolve to a single segment file (`app/chat/[[...id]]/page.tsx`), which renders `Home` (`_home.tsx`). The root `/` is a server-side `redirect('/chat')` (no React tree mounts there). The shell hooks (sidebar, conversation list, Figma bridge, MCP) live in `app/chat/layout.tsx` and survive sibling navigation; the page below only re-renders, it does not remount.

Inside `_home.tsx` (after consuming the shell via `useChatShell()`):

- `useParams()` returns `{ id }` only on `/chat/[id]`. On `/` and `/chat`, `urlId === null`.
- The hook accepts `preferredInitialId` (3rd argument). On first load, if `urlId` matches one of the user's conversations, it wins over the `is_active` flag — that's what makes pasted links land on the right conv.
- **Effect 1 (state → URL)**: when `activeConversationId` changes (sidebar click, `+`, delete, orchestration auto-switch via `useOrchestrationConversation`), pushes `/chat/<id>` or `/chat` via `router.replace`. Guarded by `lastPushedIdRef` to ignore back/forward navigation that the second effect will handle.
- **Effect 2 (URL → state)**: when the URL changes externally (browser back/forward, paste-link), calls `setActiveConversation(urlId)` if the id is valid, otherwise `router.replace('/chat')`.

## Auth & middleware

`src/proxy.ts` runs as the request matcher for everything except `_next/static`, image extensions, and static fonts. `/chat` and `/chat/[id]` are NOT in `PUBLIC_PAGES`, so the Supabase auth check applies automatically: unauthenticated visits redirect to `/login`. No middleware change was needed when adding these routes.

After login, the middleware currently sends the user back to `/` (which then redirects to `/chat` or `/chat/<lastActiveId>`). Preserving the original `/chat/<uuid>` URL through the login round-trip is a separate concern (would need a `?redirect=` param).

## Figma plugin & overlay

The plugin loads the webapp inside an iframe pointing at `/` or `/chat` (depending on the plugin build's `GUARDIAN_URL`). Internally, `router.replace` still fires and the URL changes inside the iframe, but the user never sees the URL bar — so there is no UX change from the plugin's perspective. Orchestration sub-conversation auto-switch is suppressed in plugin mode by `useOrchestrationConversation` (see `isFigmaPlugin` flag); when it is suppressed, the URL stays on the parent chat, which is the desired behavior.
