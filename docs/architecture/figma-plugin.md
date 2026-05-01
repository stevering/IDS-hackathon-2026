# Guardian Figma Plugin — Architecture

## Overview

The Guardian Figma plugin is a multi-bridge system that connects the Figma canvas to external services (AI agents, MCP servers, Electron overlay, webapp). It runs as two separate execution contexts bridged by `postMessage`.

**Three plugin variants** share the same codebase:

| Variant | ID | Specifics |
|---|---|---|
| Guardian Plugin | ...447 | Standard plugin |
| Guardian Desktop Plugin | ...448 | `enablePrivatePluginApi: true` |
| Guardian Widget | ...687 | `containsWidget: true`, canvas badge with multi-user sessions |

## Sandbox Architecture

Figma plugins run in two isolated contexts. This is a Figma platform constraint, not a design choice.

```
┌─────────────────────────────────────────────────────────┐
│  code.ts  (QuickJS sandbox)                             │
│                                                         │
│  HAS:    figma.* API, eval(), setTimeout                │
│  NO:     network, DOM, WebSocket, fetch                 │
│                                                         │
│  Role:   blind executor — receives orders, manipulates  │
│          the Figma document, returns results.           │
│          Does NOT know who is calling.                  │
└────────────────────────┬────────────────────────────────┘
                         │
                  postMessage (only bridge)
                  Structured Clone (data only, no functions)
                         │
┌────────────────────────▼────────────────────────────────┐
│  ui.html  (Chromium iframe)                             │
│                                                         │
│  HAS:    WebSocket, fetch, DOM, localStorage            │
│  NO:     figma.* API                                    │
│                                                         │
│  Role:   intelligent router — connects external systems │
│          to the sandbox, translates protocols, caches   │
│          data, manages UI.                              │
└─────────────────────────────────────────────────────────┘
```

## Communication Channels

### Production (published plugin on marketplace)

```
                         code.ts
                    ┌──────────────┐
                    │ EXECUTE_CODE │  (eval + guardrails)
                    │ Handlers     │  (get-selection, GET_VARIABLES, notify...)
                    │ Listeners    │  (selection, page change)
                    └──────┬───────┘
                           │ postMessage
                    ┌──────▼───────┐
                    │   ui.html    │
                    │              │
                    │ ── router ── │──────────────────────┐
                    │              │                      │
                    │              │                      ▼
                    │              │               ┌──────────────┐
                    │              │               │ Webapp       │
                    │              │               │ iframe       │
                    └──────────────┘               │ postMessage  │
                                                   └──────┬───────┘
                                                          ▼
                                                     Next.js App
                                                     (AI chat,
                                                      auth, MCP)
                                                          ▲
                                                          │
                                                     Agent via
                                                  Guardian MCP tools
                                                  (Supabase Realtime)
```

### Presence channel scoping

The Realtime channel is **scoped per authenticated user**: `guardian:execute:{userId}`. Each webapp or plugin instance subscribes to the channel matching its own Supabase auth session. This means:

- Two clients logged in with **different accounts** will join **different channels** and will NOT see each other in the Clients panel.
- The plugin (Figma Desktop iframe) and the webapp (Chrome tab) have **separate auth sessions** (different Chromium contexts). They must be logged in with the same account.

**Quick diagnostic** when clients don't see each other:

```sql
SELECT client_id, client_type, short_id, user_id, last_seen_at
FROM user_clients ORDER BY last_seen_at DESC;
```

If `user_id` differs between clients, that's the problem — log in with the same account everywhere.

### Presence resilience (preview/production)

Supabase Realtime Presence can be slow to sync in preview/production (several seconds vs near-instant locally). The presence system addresses this with several layers:

#### Connection lifecycle

1. **Keepalive interval**: 10s — re-tracks presence frequently and detects dead WS connections fast.
2. **Fallback timeout**: if no Realtime `sync` event within 5s (`PRESENCE_SYNC_TIMEOUT_MS`), the hooks end the loading state so the UI stops showing skeletons. No fake clients are injected — only Realtime determines who is truly online.
3. **Connection status**: both `useFigmaExecuteChannel` and `useGuardianPresence` expose `connectionStatus` (`connecting` | `connected` | `reconnecting`). The `ConnectedClients` component shows a blue "connecting..." or amber "reconnecting..." badge.
4. **Dead WS detection**: keepalive checks `socket.isConnected()` every 10s. If dead, clears clients, sets `reconnecting`, and forces full channel recreation via `reconnectKey`.
5. **Visibility change**: when a tab returns from hidden to visible, presence is re-tracked and state re-synced (handles overnight idle).

#### Client list behavior (`ConnectedClients`)

- **DB + Realtime merge**: DB clients (fetched at mount) are merged with Realtime presence. Presence determines online/offline status.
- **Presence-only clients**: clients connected via Realtime but not yet registered in DB appear immediately as online. They are cached in a ref so that when they disconnect, they transition to offline instead of disappearing.
- **Re-fetch on leave**: when a presence client disappears, the DB is re-fetched to pick up newly registered entries.
- **Stable ordering**: clients keep their display position across all state changes (joins, leaves, reconnects). New clients append at the bottom. Order resets to `clientId` alphabetical only on page refresh (F5).
- **Debug helper**: `window.__guardianPresenceDebug.forceReconnect()` triggers a manual reconnect cycle for testing.

#### Test coverage (48 tests)

- `useFigmaExecuteChannel.test.ts` — connection status, keepalive, execute_request broadcast, WS dead detection, subscribe errors, visibility change
- `useGuardianPresence.test.ts` — sync, fallback timeout, WS dead detection, recovery, unauthenticated, debug helper
- `ConnectedClients.test.tsx` — loading/badges, DB+presence merge, presence-only lifecycle, stable ordering, F5 reset, type icons/labels, MCP/Figma context display

In production: only the webapp bridge is active. No WS connections (blocked by `allowedDomains`).
FC Bridge code exists in ui.html but is dead code (scan fails silently).
Proxy handler and console capture exist in code.ts but are never triggered.

### Local development (desktop plugin)

```
                         code.ts
                    ┌──────────────┐
                    │ Proxy Handler│  (7 RPC primitives)        ← LOCAL ONLY
                    │ EXECUTE_CODE │  (eval + guardrails)
                    │ Listeners    │  (selection, page, document, console)
                    │ Handlers     │  (get-selection, GET_VARIABLES, notify...)
                    │ Console cap. │  (monkey-patch log/warn/error)  ← LOCAL ONLY
                    │ Doc change   │  (loadAllPages + documentchange) ← LOCAL ONLY
                    └──────┬───────┘
                           │ postMessage
                    ┌──────▼───────┐
                    │   ui.html    │
                    │              │
          ┌──────── │ ── router ── │────────┬──────────────┐
          │         │              │        │              │
          ▼         │              │        ▼              ▼
    ┌──────────┐    │              │  ┌──────────┐  ┌──────────────┐
    │ FC Bridge│    │              │  │ Guardian │  │ Webapp       │
    │ WS 9223+ │    │              │  │ Bridge   │  │ iframe       │
    │ LOCAL    │    │              │  │ WS 3002  │  │ postMessage  │
    └────┬─────┘    │              │  │ LOCAL    │  └──────┬───────┘
         │          └──────────────┘  └────┬─────┘         │
         ▼                                ▼              ▼
    FC MCP Server                  Electron         Next.js App
    (WS, local only)              Overlay            (localhost
         ▲                        (local only)        or cloud)
         │                                               ▲
         │                                               │
    Agent via                                       Agent via
    FC MCP tools                                 Guardian MCP tools

    ─── Collab path (Temporal, LOCAL ONLY) ─────────────────

    Temporal worker
         │
         ├── stdio pool (1 subprocess per agent)        ← LOCAL ONLY
         │   └── npx figma-console-mcp (persistent)     ← LOCAL ONLY
         │       │
         │       ├── Supabase broadcast "connect_fc_port"
         │       │   → webapp → plugin (instant connect <1s)
         │       │
         │       └── WS port ← plugin connects immediately
         │
         └── figmaconsole_* tool calls → pool → stdio → WS → plugin

    ─── Collab path (Temporal, PRODUCTION) ──────────────────

    Temporal worker
         │
         └── figmaconsole_* tool calls → HTTP → figma-console-mcp.southleft.com
             (no subprocess, no WS, no plugin — REST API only)
```

### What changes between local and production

| Component | Local dev | Production |
|---|---|---|
| FC Bridge (ui.html) | Active — scans WS 9223-9232, instant connect | Dead code — WS blocked by manifest |
| Guardian Bridge (ui.html) | Active — WS 3002 to Electron | Dead code — WS blocked by manifest |
| Proxy handler (code.ts) | Active — used by FC Bridge adapters | Dead code — never called |
| Console capture (code.ts) | Active — forwards to FC Bridge | Dead code — no FC consumer |
| Document change listener (code.ts) | Active — cache invalidation for FC | Dead code — no FC consumer |
| Temporal stdio pool (mcp.ts) | Active — 1 subprocess per agent | Disabled — `NODE_ENV=production` guard |
| FC MCP routing | Local stdio subprocess → WS → plugin | HTTP to Southleft cloud → REST API |
| Webapp (Next.js) | localhost:3000 | Vercel/cloud |
| `connect_fc_port` broadcast | Active — Temporal → Supabase → webapp → plugin | Never triggered |

**Note**: A build-time split (`BUILD_TARGET=marketplace`) is planned to strip local-only code from the marketplace plugin build. See `docs/backlog/plugin-marketplace-build-split.md`.

## code.ts — Plugin Sandbox

### Message Handlers

| Type | Purpose |
|---|---|
| `PROXY_CALL` | Call a method on figma.* or a stored handle |
| `PROXY_GET` | Read a property from a handle |
| `PROXY_SET` | Write a property on a handle |
| `PROXY_SNAPSHOT` | Read multiple properties from a handle in one call |
| `PROXY_ITERATE` | Snapshot each element of an array handle |
| `PROXY_CALL_EACH` | Call the same method N times with different args |
| `PROXY_RELEASE` | Free handles from the store |
| `EXECUTE_CODE` | Eval arbitrary JS with guardrails |
| `get-selection` | Snapshot selection (simplified nodes + PNG + URL) |
| `GET_VARIABLES` | Fetch all local variables and collections |
| `get-file-info` | File name, fileKey, pages, current user |
| `HIGHLIGHT_NODE` | Select and zoom to a node |
| `notify` | Show a Figma toast notification |
| `storage-get/set` | Read/write clientStorage |
| `BACKEND_STATUS` | Persist status for widget badge |
| `OPEN_PLUGIN_AND_CONVERSE` | Show plugin UI + trigger analysis |

### Figma Event Listeners

| Event | Emits | Purpose |
|---|---|---|
| `selectionchange` | `selection-changed` | Stream selection to all bridges |
| `currentpagechange` | `page-changed` | Track page navigation |
| `documentchange` | `DOCUMENT_CHANGE` | Cache invalidation (requires `loadAllPagesAsync`) |
| `close` | sharedPluginData update | Widget badge status |

### Console Capture

Monkey-patches `console.log/info/warn/error/debug` to forward logs as `CONSOLE_CAPTURE` messages to ui.html. The FC Bridge broadcasts these to connected MCP servers.

### EXECUTE_CODE Guardrails

| Guardrail | Purpose |
|---|---|
| Block `figma.closePlugin()` | Prevents LLM from killing orchestrations |
| HTML entity decode | Guards against `&amp;` / `&lt;` in LLM output |
| Figma API autocorrect | Removes invalid `a:` (alpha) from color objects in fills/strokes |
| Timeout (default 15s) | Prevents infinite loops |
| Sentinel error pattern | `__guardian_exec_error` for reliable error surfacing |
| JSON serializability check | Catches non-serializable returns |

### Proxy Handle System

Figma node objects are non-serializable (they have methods, circular refs). The Proxy solves this:

1. code.ts stores the real Figma object in `_proxyHandles` Map
2. Returns a handle ID string (e.g., `"h_1"`) through postMessage
3. ui.html uses this handle ID in subsequent calls
4. code.ts resolves the handle back to the real object before calling methods

**Serialization rules for PROXY_CALL/GET results:**
- `null` / `undefined` → sent as `null`
- Primitives (string, number, boolean) → sent directly
- `symbol` (figma.mixed) → sent as `"__FIGMA_MIXED__"`
- Objects (nodes, arrays, Uint8Array) → always stored as handle, ID returned

## ui.html — UI Layer

### FigmaProxy Client

Async wrapper around the Proxy postMessage protocol. Tracks pending requests with timeout.

```js
FigmaProxy.call(target, method, args)    // → handle or scalar
FigmaProxy.get(handle, prop)             // → value or handle
FigmaProxy.set(handle, prop, value)      // → true
FigmaProxy.snapshot(handle, props)       // → { prop1: val1, ... }
FigmaProxy.iterate(handle, props)        // → [{ ... }, { ... }, ...]
FigmaProxy.callForEach(handle, m, args)  // → true (batch)
FigmaProxy.release(...handles)           // → true (cleanup)
FigmaProxy.executeCode(code, timeout)    // → result (EXECUTE_CODE passthrough)
```

### FC WS Bridge (Figma Console MCP Compatibility)

Makes the Guardian plugin respond to `npx figma-console-mcp` WebSocket protocol. The MCP server sees Guardian as if it were the Figma Console Desktop Bridge plugin.

**Connection (two mechanisms):**
- **Periodic scan**: Scans ports 9223-9232 every 15s, connects to ALL active MCP servers
- **Instant connect**: Receives `CONNECT_FC_PORT` message from webapp (triggered by Temporal via Supabase broadcast), connects to specific port immediately (<1s)
- Reconnect with exponential backoff (500ms → 30s, max 50 attempts)
- On connect: sends cached `VARIABLES_DATA` + `FILE_INFO`
- Exposes `window.__connectFCPort(port)` for programmatic connection

**Protocol:**
```
MCP Server → Plugin:  { id: 42, method: "RESIZE_NODE", params: { nodeId, width, height } }
Plugin → MCP Server:  { id: 42, result: { success: true, node: { id, name, width, height } } }
Plugin → MCP Server:  { id: 42, error: "Node not found: 999:999" }
```

**34 method adapters** translate FC MCP methods into Proxy calls:

| Category | Methods | Proxy Pattern |
|---|---|---|
| Node ops (12) | RESIZE, MOVE, CLONE, DELETE, RENAME, OPACITY, CORNER_RADIUS, DESCRIPTION, FILLS, STROKES, GET_COMPONENT, CREATE_CHILD | `getNode` → `call/set` → `snapshot` |
| Component ops (4) | EDIT/DELETE/ADD_COMPONENT_PROPERTY, SET_INSTANCE_PROPERTIES | `getNode` → `call` → `snapshot` |
| Variable ops (9) | CREATE/UPDATE/DELETE/RENAME_VARIABLE, SET_VAR_DESC, CREATE_VAR_COLL, ADD/RENAME/DELETE_MODE | `call` → `callForEach` → `snapshot` |
| Complex (5) | SET_TEXT_CONTENT, INSTANTIATE_COMPONENT, GET_LOCAL_COMPONENTS, REFRESH_VARIABLES, CAPTURE_SCREENSHOT | `call` → `iterate` / type checks / font loading |
| Passthrough (5) | EXECUTE_CODE, GET_VARIABLES_DATA, GET_FILE_INFO, CLEAR_CONSOLE, RELOAD_UI | Direct or cached |

**ISO compliance:** Response formats and error messages match the native Figma Console Desktop Bridge plugin exactly. The MCP server cannot distinguish Guardian from the native plugin. Tested against **figma-console-mcp v1.11.1/v1.11.2** (2026-03-20).

**Event broadcasting** to all connected MCP servers:

| Event | Trigger |
|---|---|
| `SELECTION_CHANGE` | User selects nodes |
| `PAGE_CHANGE` | User switches page |
| `DOCUMENT_CHANGE` | Nodes/styles modified |
| `CONSOLE_CAPTURE` | Plugin console output |
| `VARIABLES_DATA` | Variables refreshed |

### Guardian Bridge (Electron Overlay)

Connects to the Electron overlay app via WebSocket on port 3002.

**Handshake:** `REGISTER { clientType: plugin|widget, widgetId, fileKey }` → `REGISTERED { clientId }`

| Direction | Messages |
|---|---|
| Overlay → Plugin | PING, TRIGGER_ANALYSIS, OPEN_PLUGIN_AND_CONVERSE, NOTIFY, EXECUTE_CODE, HIGHLIGHT_NODE |
| Plugin → Overlay | PONG, EXECUTE_CODE_RESULT, SELECTION_CHANGED, AUTH_STATE |

### Webapp Iframe

Embeds the Next.js Guardian webapp (chat AI, auth, MCP tools).

| Direction | Messages |
|---|---|
| ui.html → Webapp | figma-context, selection-changed, VARIABLES_DATA, EXECUTE_CODE_RESULT, set-theme, figpal-init |
| Webapp → ui.html | AUTH_STATE, request-figma-context, EXECUTE_CODE, GET_VARIABLES, HIGHLIGHT_NODE, notify |

#### postMessage origin validation

The iframe chain is: Figma (`https://www.figma.com`) → plugin UI (origin `null`, data: URL) → webapp iframe (`https://guardian.figdesys.com`). Because the plugin UI has a `null` origin (Figma sandbox), CSP `frame-ancestors` cannot be used to restrict framing.

Instead, origin validation is enforced at the application level:

- **ui.html** derives `guardianOrigin` from the iframe `src` attribute (set at build time via `__GUARDIAN_URL__`). Incoming messages from the webapp iframe are rejected unless `event.origin === guardianOrigin`. Outgoing messages to the webapp via `sendToWebview()` use `guardianOrigin` as targetOrigin instead of `'*'`.
- **useFigmaPlugin.ts** filters incoming messages to accept only `event.origin === "null"` (plugin sandbox parent) or `event.origin === window.location.origin` (self/HMR).
- **webapp → plugin UI** (`window.parent.postMessage`) must use `'*'` as targetOrigin because the parent's origin is `null`. This is a Figma platform constraint — the messages contain no secrets (AUTH_STATE is a boolean, EXECUTE_CODE is Figma JS code).

#### Orchestration view inside the plugin

The webapp iframe renders the orchestration UI (banner, Chat/Dev toggle, event view, sub-conversations) using the same hooks and components as the standalone Chrome browser. Two minor plugin-specific tweaks live in `packages/web/src/app/page.tsx`:

- `OrchestrationChatView` / `OrchestrationEventLog` receive `agentFilter={myDisplayShortId}` when `isFigmaPlugin === true` so the plugin user only sees events relevant to their agent.
- `useOrchestrationConversation` is called with `isFigmaPlugin: true`, which suppresses the auto-switch to the orchestration sub-conversation on creation. The user keeps typing in their parent chat and navigates manually via the unified `OrchestrationBanner`.

Live `execute_request` workflowIds postMessaged into the iframe are captured by `orchDetectedRef.current` and pushed into a local `liveDetectedWorkflowId` state. That feeds `useTemporalOrchestration` as `externalWorkflowId`, which in turn lets `useOrchestrationConversation` create the sub-conversation silently (no auto-switch in plugin). The historical hook `usePluginOrchestration` was removed; both contexts now share `useTemporalOrchestration` + `useOrchestrationConversation`.

### Message Router (window.onmessage)

Routes all messages from code.ts to the appropriate destination:

1. `PROXY_RESULT` → FigmaProxy client (resolve pending Promise) — **not forwarded to webapp**
2. `EXECUTE_CODE_RESULT` → FigmaProxy client + webapp + Electron bridge
3. `VARIABLES_DATA` → cache + FC broadcast + webapp
4. `selection-changed` → UI update + FC broadcast + webapp + Electron
5. `DOCUMENT_CHANGE` / `CONSOLE_CAPTURE` → FC broadcast
6. Everything else → `sendToWebview()` catch-all

**Note:** The Guardian Bridge Client patches `window.onmessage` to intercept messages after the main router processes them. It forwards `EXECUTE_CODE_RESULT` to Electron and mirrors selection changes.

## Widget

The widget (`packages/figma-widget/`) displays a canvas badge showing Guardian status:

- Green: "You're guarding" (current user has plugin open)
- Purple: "N guardians active" (other users have plugin open)
- Gray: "No guardian active"

**Multi-user tracking:** `useSyncedMap('sessions')` with heartbeat (3s) and TTL (30s).

**Click** opens the same ui.html as the standalone plugin via `figma.showUI()`.

Shares `bridge.ts` with the plugin: `sendFigpalInit`, `setupPageChangeListener`, `handleBasicMessage`, `buildNodeUrl`.

## Complete Message Handler Matrix

All message types handled by the plugin, showing FC MCP compatibility, Guardian-specific handlers,
and which MCP tools use each handler.

Legend: **FC** = Figma Console MCP WS method, **G** = Guardian-only handler, **Overlap** = equivalent exists in both

| # | Handler | Origin | Description | FC MCP Tools | Guardian MCP Tools | Tested E2E | ISO FC 1.15.5 |
|---|---------|:---:|---|---|---|:---:|:---:|
| 1 | `EXECUTE_CODE` | FC+G | Eval arbitrary JS in sandbox with guardrails | `figma_execute`, `figma_get_selection` (verbose), `figma_get_variables` (fallback) | `figma_execute`, `run_action` (all 6 actions), `list_page_children` | ✅ s+e | ✅ |
| 2 | `RESIZE_NODE` | FC | Resize a node (width, height, constraints) | `figma_resize_node` | — | ✅ s+e | ✅ |
| 3 | `MOVE_NODE` | FC | Move a node (x, y) | `figma_move_node` | — | ✅ s+e | ✅ |
| 4 | `CLONE_NODE` | FC | Duplicate a node | `figma_clone_node` | — | ✅ s+e | ✅ |
| 5 | `DELETE_NODE` | FC | Remove a node | `figma_delete_node` | — | ✅ s+e | ✅ |
| 6 | `RENAME_NODE` | FC | Set node name | `figma_rename_node` | — | ✅ s+e | ✅ |
| 7 | `SET_NODE_OPACITY` | FC | Set node opacity (0-1) | `figma_set_opacity`* | — | ✅ s+e | ✅ |
| 8 | `SET_NODE_CORNER_RADIUS` | FC | Set corner radius | `figma_set_corner_radius`* | — | ✅ s+e | ✅ |
| 9 | `SET_NODE_DESCRIPTION` | FC | Set description (Components only) | `figma_set_description` | — | ✅ s+e | ✅ |
| 10 | `SET_NODE_FILLS` | FC | Set fills with hex→RGB conversion | `figma_set_fills` | — | ✅ s+e | ✅ |
| 11 | `SET_NODE_STROKES` | FC | Set strokes with hex→RGB + weight | `figma_set_strokes` | — | ✅ s+e | ✅ |
| 12 | `SET_TEXT_CONTENT` | FC | Set text (loadFont + fontSize) | `figma_set_text` | — | ✅ s+e | ✅ |
| 13 | `CREATE_CHILD_NODE` | FC | Create child node by type | `figma_create_child` | — | ✅ s+e | ✅ |
| 14 | `CAPTURE_SCREENSHOT` | FC | Export node as PNG base64 | `figma_capture_screenshot` | — | ✅ s+e | ✅ |
| 15 | `SET_IMAGE_FILL` | FC | Set image fill (base64 decode + createImage) | `figma_set_image_fill` | — | ✅ s+e | ✅ |
| 16 | `SET_INSTANCE_PROPERTIES` | FC | Set component instance properties | `figma_set_instance_properties` | — | ✅ s | ✅ |
| 17 | `GET_COMPONENT` | FC | Get component metadata | `figma_get_component` | — | ✅ s | ✅ |
| 18 | `ADD_COMPONENT_PROPERTY` | FC | Add property to component (returns #hash name) | `figma_add_component_property` | — | ✅ s+e | ✅ |
| 19 | `EDIT_COMPONENT_PROPERTY` | FC | Edit component property value | `figma_edit_component_property` | — | ✅ s | ✅ |
| 20 | `DELETE_COMPONENT_PROPERTY` | FC | Delete component property | `figma_delete_component_property` | — | ✅ s | ✅ |
| 21 | `CREATE_VARIABLE` | FC | Create variable (collection object in dynamic-page) | `figma_create_variable` | — | ✅ s | ✅ |
| 22 | `UPDATE_VARIABLE` | FC | Set variable value for mode | `figma_update_variable` | — | ✅ s | ✅ |
| 23 | `DELETE_VARIABLE` | FC | Remove a variable | `figma_delete_variable` | — | ✅ s | ✅ |
| 24 | `RENAME_VARIABLE` | FC | Rename a variable | `figma_rename_variable` | — | ✅ s | ✅ |
| 25 | `SET_VARIABLE_DESCRIPTION` | FC | Set variable description | (via FC tools) | — | ✅ s | ✅ |
| 26 | `CREATE_VARIABLE_COLLECTION` | FC | Create variable collection + modes | `figma_create_variable_collection` | — | ✅ s | ✅ |
| 27 | `DELETE_VARIABLE_COLLECTION` | FC | Delete variable collection | `figma_delete_variable_collection` | — | ✅ s | ✅ |
| 28 | `ADD_MODE` | FC | Add mode to collection | `figma_add_mode` | — | ✅ s | ✅ |
| 29 | `RENAME_MODE` | FC | Rename a mode | `figma_rename_mode` | — | ✅ s | ✅ |
| 30 | `INSTANTIATE_COMPONENT` | FC | Import + instantiate (variant matching) | `figma_instantiate_component` | — | ✅ s | ✅ |
| 31 | `REFRESH_VARIABLES` | FC | Full fetch all variables + collections | `figma_get_variables` (refresh) | — | ✅ s | ✅ |
| 32 | `GET_LOCAL_COMPONENTS` | FC | List all local components | `figma_get_local_components`* | — | ✅ s | ✅ |
| 33 | `GET_VARIABLES_DATA` | FC | Return cached variables (no round-trip) | `figma_get_variables` (cache) | — | ✅ s | ✅ |
| 34 | `GET_FILE_INFO` | FC | File name, key, page, selection count | `figma_get_status`, `figma_list_open_files` | — | ✅ s | ✅ |
| 35 | `CLEAR_CONSOLE` | FC | No-op (buffer server-side) | `figma_clear_console` | — | ✅ s | ✅ |
| 36 | `RELOAD_UI` | FC | Reload plugin UI | `figma_reload_plugin` | — | ✅ s | ✅ |
| 37 | `LINT_DESIGN` | FC | WCAG accessibility audit (~500 lines) | `figma_lint_design` | — | ✅ stub | ⚠️ stub |
| — | — | — | — | — | — | — | — |
| 38 | `get-selection` | **Overlap** | Snapshot selection (nodes + PNG + URL) | — | via `run_action(get_selection_context)` | — | — |
| 39 | `GET_VARIABLES` | **Overlap** | Fetch all variables + collections | — | via `run_action(get_ds_variables)` | — | — |
| 40 | `get-file-info` | **Overlap** | File name, key, pages, user | — | webapp context init | — | — |
| 41 | `HIGHLIGHT_NODE` | G | Select + zoom to a node by ID | — | Electron overlay | — | — |
| 42 | `notify` | G | Show Figma toast notification | — | Electron overlay | — | — |
| 43 | `notify-login-prompt` | G | "Sign in to Guardian" toast with button | — | Auth timer (unauthenticated mode) | — | — |
| 44 | `BACKEND_STATUS` | G | Persist status for widget badge | — | Widget badge via clientStorage | — | — |
| 45 | `storage-get` | G | Read clientStorage | — | Theme, URL, bridge status | — | — |
| 46 | `storage-set` | G | Write clientStorage | — | Theme, URL, bridge status | — | — |
| 47 | `OPEN_PLUGIN_AND_CONVERSE` | G | Show plugin + trigger analysis | — | Electron overlay | — | — |
| 48 | `PROXY_CALL` | G | Call method on figma.* or handle | — | FC Bridge adapters (engine) | — | — |
| 49 | `PROXY_GET` | G | Read property from handle | — | FC Bridge adapters (engine) | — | — |
| 50 | `PROXY_SET` | G | Write property on handle | — | FC Bridge adapters (engine) | — | — |
| 51 | `PROXY_SNAPSHOT` | G | Read N properties in one call | — | FC Bridge adapters (engine) | — | — |
| 52 | `PROXY_ITERATE` | G | Snapshot each element of array | — | FC Bridge adapters (engine) | — | — |
| 53 | `PROXY_CALL_EACH` | G | Batch call same method N times | — | FC Bridge adapters (engine) | — | — |
| 54 | `PROXY_RELEASE` | G | Free handles from store | — | FC Bridge adapters (engine) | — | — |

*Some FC MCP tools use EXECUTE_CODE internally rather than dedicated WS methods.

**FC MCP compatibility: 36/37 implemented, 1 stub. 194 E2E assertions, 0 failures.**
**Tested against figma-console-mcp v1.15.5 (2026-03-22).**

### Collab integration (Temporal → FC MCP → Plugin)

Two connection modes depending on the environment:

**Local dev** (stdio subprocess):
1. Launches a **persistent stdio subprocess** `npx figma-console-mcp` (1 per agent, pooled in the Temporal worker)
2. Discovers the subprocess's WS port via `/tmp/figma-console-mcp-{port}.json`
3. **Broadcasts `connect_fc_port`** via Supabase Realtime → webapp forwards → plugin connects instantly (<1s)
4. **Polls `figma_get_status`** until the plugin is confirmed connected
5. Agent LLM calls `figmaconsole_*` tools → routed through the persistent subprocess → WS → Guardian FC Bridge → Proxy → code.ts

**Production/preview** (Southleft cloud relay):
1. Agent workflow detects `figma_console` (not `figma_console_local`) in mcpServerIds
2. Calls `pairFCCloudRelay` activity → connects to Southleft HTTP MCP → calls `figma_pair_plugin` → gets 6-char pairing code
3. **Broadcasts `connect_fc_cloud_relay`** via Supabase Realtime → webapp forwards → plugin auto-connects to `wss://figma-console-mcp.southleft.com/ws/pair?code=XXXXXX`
4. Cloud relay WebSocket established → added to FC Bridge handler pool (same handlers as local WS)
5. Agent LLM calls `figmaconsole_*` tools → routed through Southleft HTTP → cloud relay → WS → Guardian FC Bridge → Proxy → code.ts

**Key fixes for AI SDK v6 compatibility:**
- Tool parameters extracted from `inputSchema.jsonSchema` (not `parameters` which is `undefined` for MCP tools)
- `jsonSchema()` wrapper requires `{ validate: (v) => ({ success: true, value: v }) }` passthrough validator
- Tool call results use `tc.input` (DynamicToolCall) not `tc.args` (StaticToolCall)

**Canvas diff pipeline**: External tool calls that modify Figma (`isFigmaWriteTool`) go through the same before/after snapshot + screenshot + file review LLM pipeline as `figma_plugin_execute`.

### Guardian handlers that overlap with FC methods

Three Guardian-only handlers have functional equivalents in FC:

| Guardian handler | FC equivalent | Can replace? |
|---|---|---|
| `get-selection` (#38) | `EXECUTE_CODE` with selection code | No — Guardian version includes PNG export + nodeUrl that FC doesn't |
| `GET_VARIABLES` (#39) | `REFRESH_VARIABLES` (#31) | Yes — same data, same API calls. Could migrate to Proxy internally |
| `get-file-info` (#40) | `GET_FILE_INFO` (#34) | Partially — Guardian returns `fileUrl`, `pages[]`, `currentUser` which FC doesn't |

The remaining Guardian handlers (#41-54) have no FC equivalent — they serve Guardian-specific features (widget badge, Electron overlay, auth, Proxy engine).

## Proxy vs EXECUTE_CODE — Current Usage

| Consumer | Uses Proxy? | Uses EXECUTE_CODE? | Migration candidate? |
|---|---|---|---|
| FC Bridge adapters | Yes (36 methods) | EXECUTE_CODE passthrough + SET_IMAGE_FILL + GET_FILE_INFO | Done |
| Collab agents (figmaconsole_* via Temporal) | Yes (via FC Bridge) | figmaconsole_figma_execute | Done — preferred over figma_plugin_execute |
| Guardian MCP actions (get_selection_context, etc.) | No | Yes (JS templates) | Yes |
| Guardian MCP tools (list_page_children) | No | Yes (inline JS strings) | Yes |
| Webapp hook (useFigmaPlugin.executeCode) | No | Yes (passthrough) | Partially (agent-generated code stays as EXECUTE_CODE) |
| Electron overlay | No | Yes (forwarded) | Yes |
| figma_execute tool (arbitrary code) | No | Yes | No (intentionally — arbitrary code execution is its purpose) |

## Manifests — Network Access

**Production (allowedDomains):**
- LLM providers: Google, OpenAI, Anthropic, X.AI
- Resources: Google Fonts, GitHub raw

**Development (devAllowedDomains):**
- `localhost:3000` (webapp)
- `ws://localhost:3002` (Electron overlay)
- `ws://localhost:9223-9232` (FC MCP servers, 10 ports)
- Vercel preview URLs, figdesys.com domains

**Permissions:** `currentuser`, `teamlibrary` (needed for `importComponentByKeyAsync`)

## Key Constants

| Constant | Value |
|---|---|
| Plugin size | 400x800 (expanded), 400x100 (minimized) |
| FC MCP ports | 9223-9232 (10 ports) |
| Electron port | 3002 |
| Selection limit | 50 nodes |
| Text extraction limit | 10,000 chars |
| Code timeout | 15s default |
| FC periodic rescan | 15s interval |
| FC instant connect | <1s via Supabase broadcast |
| FC reconnect backoff | max 50 attempts, 500ms → 30s |
| Stdio pool TTL | 10 min idle → close subprocess |
| Port file location | `/tmp/figma-console-mcp-{port}.json` |
| Widget heartbeat | 3s, TTL 30s |

## Local vs Production

### Two plugin packages, one codebase

| | `figma-plugin` | `figma-desktop-plugin` |
|---|---|---|
| **Target** | Figma marketplace (published) | Local dev only (never published) |
| **ID** | ...447 | ...448 |
| **`enablePrivatePluginApi`** | `false` | `true` |
| **`teamlibrary` permission** | Should be removed before publish | Yes (needed for INSTANTIATE_COMPONENT) |
| **WS localhost (9223-9232)** | `devAllowedDomains` only (blocked in published plugin) | `devAllowedDomains` (always in dev mode) |
| **FC Bridge, Proxy, console capture** | Dead code in published build (WS blocked) | Active and used |

Both packages share the exact same `code.ts`, `ui.html`, and `bridge.ts`. Only the `manifest.json` differs.

### What runs where

```
LOCAL DEV                                    PRODUCTION (CLOUD)
──────────                                   ──────────────────

Figma Desktop                                Figma Desktop (user's machine)
├── Guardian Plugin (desktop variant)        ├── Guardian Plugin (marketplace variant)
│   ├── code.ts (all handlers)               │   ├── code.ts (all handlers — FC ones are dead code)
│   ├── ui.html (FC Bridge active)           │   ├── ui.html (FC Bridge blocked by allowedDomains)
│   └── WS 9223-9232 ← FC MCP servers        │   └── WS blocked (no localhost in allowedDomains)
│
├── FC MCP Server (npx, user-launched)       (not present — no local MCP server on user's machine)
│   └── WS port 9224
│
├── FC MCP Subprocess (Temporal-launched)     (not present — guarded by NODE_ENV check)
│   └── WS port 9228
│
Temporal Worker (local)                      Temporal Worker (cloud)
├── stdio pool (figma_console_local)         ├── stdio pool DISABLED (NODE_ENV=production)
├── /tmp/figma-console-mcp-*.json            ├── (no port files)
├── Supabase broadcast connect_fc_port       ├── (no broadcast)
└── MCP HTTP (figma_console, github)         └── MCP HTTP only (figma_console, github, figma_mcp)

Guardian MCP Server (local)                  Guardian MCP Server (cloud)
├── start_collab includes                    ├── start_collab EXCLUDES
│   figma_console_local (stdio)              │   figma_console_local (NODE_ENV=production)
└── figma_console (HTTP, remote)             └── figma_console (HTTP, remote) ← only FC path

Webapp (localhost:3000)                      Webapp (Vercel/cloud)
├── connect_fc_port handler (active)         ├── connect_fc_port handler (never triggered)
└── execute_request handler (active)         └── execute_request handler (active)
```

### Production safety guards

Three layers prevent stdio/local code from running in production:

| Layer | File | Guard | Effect |
|---|---|---|---|
| 1. Entry point | `start-collab.ts` | `NODE_ENV !== "production"` | `figma_console_local` not added to `mcpServerIds` |
| 2. Discovery | `mcp.ts` discoverMCPTools | `NODE_ENV === "production"` | Skip stdio servers, log warning |
| 3. Execution | `mcp.ts` executeMCPTool | `NODE_ENV === "production"` | Return error instead of spawning subprocess |

Override: `ENABLE_LOCAL_MCP=true` bypasses all three guards (for staging/testing).

### Plugin manifest — network access

| Domain | `allowedDomains` (prod) | `devAllowedDomains` (dev) |
|---|---|---|
| LLM providers (Google, OpenAI, Anthropic, X.AI) | ✅ | ✅ |
| Google Fonts, GitHub raw | ✅ | ✅ |
| `https://figma-console-mcp.southleft.com` | ✅ | ✅ |
| `wss://figma-console-mcp.southleft.com` | ✅ | ✅ |
| `localhost:3000` (webapp) | ❌ | ✅ |
| `ws://localhost:3002` (Electron) | ❌ | ✅ |
| `ws://localhost:9223-9232` (FC MCP) | ❌ | ✅ |
| Vercel/figdesys.com URLs | ❌ | ✅ |

In cloud mode (`isCloudMode` — iframe loads `https://` URL), the plugin skips local WS scans (ports 9223-9232) and Electron overlay connection (localhost:3002) to avoid console spam. FC Cloud Relay (WSS) is used instead for `figmaconsole_*` write tools.

In a published plugin, `devAllowedDomains` is ignored — the FC Bridge scan fails silently (no WS available).

### Future: marketplace build split

A build-time split (`BUILD_TARGET=marketplace|desktop`) is planned to strip FC Bridge code from the marketplace build entirely. See `docs/backlog/plugin-marketplace-build-split.md`.

## Build

```bash
pnpm --filter @guardian/figma-plugin build   # esbuild code.ts → dist/code.js + dist/ui.html
pnpm --filter @guardian/figma-plugin dev     # watch mode (auto-rebuild on code.ts change)
```

### GUARDIAN_URL environment variable

The webapp URL embedded in the plugin iframe is configurable at build time via the `GUARDIAN_URL` env var (default: `http://localhost:3000`).

```bash
# Local dev (default)
pnpm --filter @guardian/figma-plugin build

# Preview environment
GUARDIAN_URL=https://preview.guardian.figdesys.com pnpm --filter @guardian/figma-plugin build

# Production
GUARDIAN_URL=https://guardian.figdesys.com pnpm --filter @guardian/figma-plugin build
```

For an end-to-end preview test (plugins + widget + Electron overlay all pointed at `preview.guardian.figdesys.com` in watch mode), use `pnpm dev:preview` from the repo root. The script also aliases `GUARDIAN_CLOUD_URL=$GUARDIAN_URL` so the overlay's status poll lands on the same environment.

`ui.html` contains the placeholder `__GUARDIAN_URL__` which is replaced at build time → `dist/ui.html`. The manifest points to `dist/ui.html` (not the source `ui.html`). Both the plugin and widget builds perform this substitution.

`bridge.ts` is imported by both plugin `code.ts` and widget `widget-src/code.tsx`, bundled by esbuild into each.
