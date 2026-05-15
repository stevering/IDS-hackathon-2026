# Chat state architecture

Status: **Phase B.1 shipped** (Phase 0 + A + B.1 of [`chat-layout-based-state-hoisting`](../../internal/docs/backlog/chat-layout-based-state-hoisting.md)). Phases B.2, C, D, E remain on the backlog.

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

## What's still in `_home.tsx`

- Approval state + `<ApprovalOverlay>` rendering (Promise resolver dies with the conversation — intentional).
- The header (Guardian title, `EditableClientId`, `UserMenu`, `MCPStatusBar`, `OrchestrationStatusBar`, `OrchestrationBanner`, error banners) — has dependencies on `useTemporalOrchestration` and `useOrchestrationConversation` that have not yet been hoisted.
- `<PeekBanner>` instances (MCP errors + chat errors) — pending Phase B.2.
- `<ProxyModal>` — pending Phase B.2.
- The state ↔ URL sync effects (`Effect 1`, `Effect 2`, `lastPushedIdRef`, `prevActiveIdRef`) — pending Phase D (URL as source of truth).

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
