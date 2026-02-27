# Guardian — Figma Plugin

Standalone Figma plugin that opens the Guardian AI assistant interface.

## Purpose

This package is the **plugin entry point**: it appears in Figma's **Plugins** menu and can be run independently, without any widget on the canvas. It provides the full Guardian UI — chat, API key management, design system analysis — embedded in a Figma panel.

## Architecture

```
figma-plugin/
├── manifest.json     — Plugin-only manifest (no containsWidget)
│                       main: dist/code.js  |  ui: ui.html
├── code.ts           — Plugin main thread: opens the UI, handles messages,
│                       reads/writes figma.clientStorage
├── bridge.ts         — Shared with the widget: sendFigpalInit, setupPageChangeListener,
│                       handleBasicMessage, buildNodeUrl
├── dist/code.js      — Bundled output (esbuild: code.ts + bridge.ts)
├── ui.html           — Plugin UI: single HTML file embedding the webapp
│                       in an iframe + Figma ↔ webapp bridge logic
│                       ⚠ Source of truth — also copied by the widget build
├── build.mjs         — Build script (esbuild, supports --watch)
├── tsconfig.json     — For IDE / type-checking only
└── package.json
```

**Runtime flow:**

```
User → Figma Plugins menu → Guardian
  → Figma loads manifest.json
  → Runs dist/code.js (main thread)
    → figma.showUI(__html__)   opens ui.html as a panel
    → ui.html probes /api/health, loads webapp in <iframe>
    → Messages flow: ui.html ↔ code.ts ↔ figma document
```

**Communication with the widget** (when both are used together):

Two independent channels are used:

| Channel | What it carries | How |
|---|---|---|
| `figma.root.setSharedPluginData` | Widget connectivity status (connected / disconnected) | Direct Figma API — no backend required |
| `/api/figma-bridge?key=<fileKey>` | Webapp-level state (AI context, selections, etc.) | HTTP calls made by the iframe webapp |

The status badge on the widget (green / amber / gray) is driven exclusively by `sharedPluginData`.
The plugin writes it on open and on close; the widget reads it on every re-render.

## Setup

Dependencies are managed at the monorepo root. From the repo root:

```bash
pnpm install
```

## Scripts

```bash
pnpm build          # esbuild: bundle code.ts + bridge.ts → dist/code.js
pnpm dev            # esbuild --watch (rebuilds on every save)
pnpm lint
pnpm lint:fix
```

## Loading in Figma

1. Open Figma Desktop
2. **Plugins** → **Development** → **Import plugin from manifest…**
3. Select `packages/figma-plugin/manifest.json`
4. Run it from **Plugins** → **Development** → **Guardian Plugin**

> The plugin and the widget use **separate manifests** and appear as two distinct items in Figma. They share `bridge.ts` at build time and `ui.html` (the widget build copies it).

---

## Figma platform limitations (widget + plugin)

The following limitations were discovered empirically. They are inherent to the Figma platform and cannot be worked around.

### 1. Only one plugin UI can be open at a time

Figma only allows one plugin UI to be open per user. Opening the standalone plugin from the Plugins menu **immediately closes** any UI opened by the widget (including a hidden monitoring UI), and vice-versa. Real-time communication between the widget and the standalone plugin via their respective UIs is therefore impossible.

### 2. A widget with no open UI is completely inert

The widget's JS sandbox is destroyed as soon as there is no open UI. No mechanism can wake up an idle widget:

| Attempted mechanism | Result |
|---|---|
| `setInterval` / `setTimeout` inside `useEffect` | Does not fire when the widget is idle |
| `figma.on('documentchange', ...)` | Does not fire when the widget is idle (confirmed empirically) |
| `figma.waitForTask(...)` | Does not exist in the widget API |
| `figma.showUI('<script>inline</script>')` | Figma's CSP blocks inline scripts — only `__html__` (the manifest `ui` file) is allowed |
| Hidden UI + `setInterval(ping, 5000)` | Pings only arrive if an execution context is already active (onClick in progress) |

### 3. Any `onClick` creates a new execution context

Any `onClick` on a widget (button, badge, `usePropertyMenu`) **creates a new execution context**, which cancels the current pending Promise and **closes any open UI** — including the standalone plugin. It is impossible to have a "Refresh" button on the widget while the standalone plugin is open.

### 4. `usePropertyMenu` behaves identically to `onClick`

Context menu entries (right-click → widget menu) share the same behaviour: new execution context, closure of any open UI.

### 5. Stale closure in `figma.ui.onmessage`

The `figma.ui.onmessage` handler captures synced state variables at creation time. If the widget re-renders without re-registering the handler, comparisons like `if (data.connected !== pluginConnected)` use a stale value. **Fix:** always call setters unconditionally (`setPluginConnected(!!data.connected)`) rather than gating on a locally captured value.

### 6. Props that crash the widget on insertion (widgetApi 1.0.0)

| Prop | Context | Reason |
|---|---|---|
| `effect={[{ type: 'DROP_SHADOW', ... }]}` | On `<AutoLayout>` | Not supported in widgetApi 1.0.0 |
| `name="..."` | On the root node | Conflicts with Figma's internal node management |

**Debugging tip:** intermediate JSX variables (`const x = <...>`) do not trigger validation — false negatives. Only test what is inside the final `return`, using bisection.

### 7. `documentAccess: dynamic-page` is incompatible with widgets

Adding `"documentAccess": "dynamic-page"` to the widget manifest throws:
```
Cannot register documentchange handler in incremental mode
```
This field is only valid for plugins, not for widgets.

---

## Widget ↔ plugin communication (eventually consistent)

`sharedPluginData` is the only reliable channel between the two:

```ts
figma.root.setSharedPluginData('guardian', 'pluginStatus', JSON.stringify({ connected: boolean, ts: number }))
```

- Readable and writable by **any plugin**, regardless of manifest ID.
- The standalone plugin writes its status on open and on close (`figma.on('close', ...)`).
- The widget reads this status in `useEffect` on every re-render (any canvas interaction: selection, move, collaborator edit, etc.).

Status is therefore **eventually consistent**, not real-time.
