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
│  code.ts  (QuickJS sandbox)                              │
│                                                          │
│  HAS:    figma.* API, eval(), setTimeout                 │
│  NO:     network, DOM, WebSocket, fetch                  │
│                                                          │
│  Role:   blind executor — receives orders, manipulates   │
│          the Figma document, returns results.             │
│          Does NOT know who is calling.                    │
└────────────────────────┬────────────────────────────────┘
                         │
                  postMessage (only bridge)
                  Structured Clone (data only, no functions)
                         │
┌────────────────────────▼────────────────────────────────┐
│  ui.html  (Chromium iframe)                              │
│                                                          │
│  HAS:    WebSocket, fetch, DOM, localStorage             │
│  NO:     figma.* API                                     │
│                                                          │
│  Role:   intelligent router — connects external systems  │
│          to the sandbox, translates protocols, caches     │
│          data, manages UI.                                │
└─────────────────────────────────────────────────────────┘
```

## Communication Channels

```
                         code.ts
                    ┌──────────────┐
                    │ Proxy Handler│  (7 RPC primitives)
                    │ EXECUTE_CODE │  (eval + guardrails)
                    │ Listeners    │  (selection, page, document, console)
                    │ Handlers     │  (get-selection, GET_VARIABLES, notify...)
                    └──────┬───────┘
                           │ postMessage
                    ┌──────▼───────┐
                    │   ui.html    │
                    │              │
          ┌─────── │ ── router ── │────────┬──────────────┐
          │        │              │        │              │
          ▼        │              │        ▼              ▼
    ┌──────────┐   │              │  ┌──────────┐  ┌──────────────┐
    │ FC Bridge│   │              │  │ Guardian │  │ Webapp       │
    │ WS 9223+ │   │              │  │ Bridge   │  │ iframe       │
    └────┬─────┘   │              │  │ WS 3002  │  │ postMessage  │
         │         └──────────────┘  └────┬─────┘  └──────┬───────┘
         ▼                                ▼               ▼
    FC MCP Server                  Electron Overlay   Next.js App
    (npx figma-                    (macOS status bar)  (AI chat,
     console-mcp)                                      auth, MCP)
         ▲                                               ▲
         │                                               │
    Agent via                                       Agent via
    FC MCP tools                                 Guardian MCP tools
```

All three bridges are **parallel entry points** to the same code.ts. They don't know about each other.

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

**Connection:**
- Scans ports 9223-9232, connects to ALL active MCP servers
- Reconnect with exponential backoff (500ms → 30s, max 50 attempts)
- On connect: sends cached `VARIABLES_DATA` + `FILE_INFO`

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

## Proxy vs EXECUTE_CODE — Current Usage

| Consumer | Uses Proxy? | Uses EXECUTE_CODE? | Migration candidate? |
|---|---|---|---|
| FC Bridge adapters | Yes (34 methods) | Only for EXECUTE_CODE passthrough | Done |
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
| FC MCP ports | 9223-9232 |
| Electron port | 3002 |
| Selection limit | 50 nodes |
| Text extraction limit | 10,000 chars |
| Code timeout | 15s default |
| FC reconnect | max 50 attempts, backoff 500ms → 30s |
| Widget heartbeat | 3s, TTL 30s |

## Build

```bash
pnpm --filter @guardian/figma-plugin build   # esbuild code.ts → dist/code.js
pnpm --filter @guardian/figma-plugin dev     # watch mode (auto-rebuild on code.ts change)
```

`ui.html` is served directly (not compiled). Changes require plugin reload in Figma.

`bridge.ts` is imported by both plugin `code.ts` and widget `widget-src/code.tsx`, bundled by esbuild into each.
