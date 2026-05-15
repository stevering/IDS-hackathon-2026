# Chat state architecture

Status: **Phases 0, A, B.1, C, D, E shipped** (see [`chat-layout-based-state-hoisting`](../../internal/docs/backlog/chat-layout-based-state-hoisting.md)). Phase B.2 (PeekBanner / ProxyModal / useOrchestrationConversation hoist) skipped — post-Phase A the page no longer remounts on sibling navigation so the rationale for hoisting `useOrchestrationConversation` falls away; PeekBanner and ProxyModal are tightly coupled to page-local state and provide marginal value for hoist.

## Goal

Eliminate the 250-400 ms sidebar flicker that used to fire on every `/chat/A` ↔ `/chat/B` and `/chat` ↔ `/chat/<id>` URL flip. Root cause was structural: `Home` was rendered both at `/` (via a client-side re-export) and at `/chat/[[...id]]`. Next.js compiled them into distinct server wrappers, so React saw two different component types and unmounted/remounted the tree on every transition — tearing down `useConversations`, `useUserMCPInstances`, `useFigmaPlugin` and the Supabase Realtime channels.

## What changed (Phase 0 + A + B.1)

### Phase 0 — Cleanup

- Deleted `packages/web/src/app/hooks/useFigmaExecutePoller.ts` (orphan; no importers).
- Deleted the `OrchestrationBackBanner` alias at the bottom of `packages/web/src/components/OrchestrationBanner.tsx`.

### Phase A — Server redirect on `/`

- `app/page.tsx` is now a **Server Component** that calls `redirect('/chat')`. No React tree mounts at `/`.
- The previous client-side `Home` lives in `app/chat/[[...id]]/_home.tsx` (segment-private, `_` prefix keeps it out of Next.js's routing surface).
- `app/chat/[[...id]]/page.tsx` is a thin client wrapper: `import Home from "./_home"; return <Home />;`.

### Phase B.1 — `app/chat/layout.tsx` + sidebar hoisting

A new layout file mounts once per session and never remounts during sibling navigation:

```
app/chat/
├── layout.tsx          ← shell: hooks + sidebar + Provider
└── [[...id]]/
    ├── page.tsx        ← thin wrapper, renders _home.tsx
    └── _home.tsx       ← page-local: header + body + ApprovalOverlay
```

#### Hooks hoisted into the layout

| Hook | Why it must persist |
|---|---|
| `useFigmaPlugin` | postMessage listener + `isFigmaPlugin` detection + plugin event log |
| `useFigmaExecuteChannel` | Supabase Realtime presence channel — dropping/resubscribing wastes 200-500 ms |
| `useClientRegistry` | Server-side client identity (shortId) — re-registration would change the badge |
| `useConversations` | The 50-conversation list `/api/conversations` (260 ms refetch otherwise) |
| `useUserMCPInstances` | MCP discovery — `/api/user/mcp-instances` (250-700 ms refetch otherwise) |

#### Approval gate plumbing — ref pattern

The execute channel's callback is created once at layout mount, but the gated `executeCode` wrapper depends on per-conversation approval state (`approvalMode`, `guardEnabled`, `allowAllSession`, `pendingApproval`) that **must** live in the page (because the resolver `Promise` dies with the conversation that triggered it).

Solution: the layout exposes `installExecuteWrapper(fn)` through context; the layout's channel callback reads `wrapperRef.current` on every call. The page installs its wrapper in a `useEffect`:

```ts
useEffect(() => {
  installExecuteWrapper(gatedExecuteCode);
  return () => installExecuteWrapper(null);
}, [installExecuteWrapper, gatedExecuteCode]);
```

Before the wrapper is installed, the channel falls back to the raw (un-gated) `executeCode`. In practice no `execute_request` can land in that one-tick window before the page mounts.

#### Context: `useChatShell()`

Exposed by `packages/web/src/lib/chat-shell-context.tsx`. Single hook for the page to read everything that lives in the layout. The full surface is documented in the type `ChatShellValue` in that file.

Throws if used outside the chat layout (no fallback, fail-fast).

## Phase C — SWR on `/api/conversations`

`useConversations` no longer maintains its own `conversations` state. SWR holds the list under the key `"/api/conversations"`, with `revalidateOnFocus: false` (mandatory: the Figma plugin iframe loses/regains focus on every action, which would otherwise produce a burst of `/api/conversations` requests).

Mutations (`createConversation`, `deleteConversation`, `updateTitle`) call `mutateConversations(updater, { revalidate: false })` so the sidebar updates instantly without a round-trip. On F5, SWR fetches once and the sidebar renders directly from the resolved data (no transient empty state).

`loadConversations` is preserved as `() => mutateConversations()` for the orchestration auto-refetch path.

## Phase D — URL as the source of truth

The two state↔URL sync effects (`Effect 1`, `Effect 2`) plus `lastPushedIdRef` and `prevActiveIdRef` are gone. `_home.tsx` derives `activeConversationId` directly from `useParams().id`. The hook's internal `activeConversationId` state still exists for backwards compatibility but is no longer the source of truth — page-level code reads from the URL.

- Sidebar `onSwitch`: `router.push('/chat/<id>')` + fire-and-forget `switchConversation(id)` (for the server-side `is_active` marker).
- Sidebar `onCreate`: `router.push('/chat')`.
- Sidebar `onDelete`: `deleteConversation(id)`; if it was the active conv, `router.push('/chat')`.
- `sendMessage`: after `ensureConversation()` creates a new conv on first message, `router.push('/chat/<newId>')` to navigate. `forceConversationId` bridges the gap for the in-flight message.

## Phase E — URL search params

`useUrlState(key, defaultValue)` in `app/hooks/useUrlState.ts` is a tiny `[value, set]` pair backed by `useSearchParams` + `router.replace`. Default values are removed from the URL when set (keeps URLs clean).

Wired so far:

| Param | Replaces | Notes |
|---|---|---|
| `?view=developer` | `orchViewMode` localStorage | First-paint fallback to `localStorage.guardian:orchViewMode` if `?view=` is absent. localStorage is still written on toggle (legacy compat). |

`?debug=` was not wired — there is no separate debug panel state in the current code (the only debug surface is a "copy debug context" button that runs synchronously).

## What's still in `_home.tsx`

- Approval state + `<ApprovalOverlay>` rendering (Promise resolver dies with the conversation — intentional).
- The header (Guardian title, `EditableClientId`, `UserMenu`, `MCPStatusBar`, `OrchestrationStatusBar`, `OrchestrationBanner`, error banners) — depends on `useTemporalOrchestration` and `useOrchestrationConversation` (still in `_home.tsx`).
- `<PeekBanner>` instances (MCP errors + chat errors) — not hoisted (state lives in the page).
- `<ProxyModal>` — not hoisted (state lives in the page).

## Known regressions (B.1)

- **Sidebar orchestration-active highlight**: the layout's `<ConversationSidebar>` passes `activeWorkflowId={null}` because `useTemporalOrchestration` still lives in `_home.tsx`. The sidebar row for the active orchestration is no longer highlighted. Restored when temporal moves to the shell (or when the active workflowId becomes URL-derived).

## File map

```
packages/web/src/
├── app/
│   ├── page.tsx                                ← Server Component, redirect('/chat')
│   └── chat/
│       ├── layout.tsx                          ← Shell layout (Phase B.1)
│       └── [[...id]]/
│           ├── page.tsx                        ← Client wrapper
│           └── _home.tsx                       ← Page-local content (header + body)
└── lib/
    └── chat-shell-context.tsx                  ← Context + types + useChatShell()
```

## Verification

`pnpm --filter @guardian/web build` passes after each phase. Runtime verification happens on the Vercel preview (`https://preview.guardian.figdesys.com`) — the local `pnpm dev` does not start the webapp in this setup.

Empirical checks to run on preview after the next push:

- Open `/chat/<A>`, click sidebar `<B>` → URL becomes `/chat/<B>`. In the browser console, `[useUserMCPInstances] mount` should appear **only** at initial login, never on the sibling transition.
- Open `/chat/<A>` → click "+ new" → URL becomes `/chat`. Sidebar does not flash empty.
- `/` should server-redirect to `/chat` with a single `[Conversations] Initializing` log (not two).
