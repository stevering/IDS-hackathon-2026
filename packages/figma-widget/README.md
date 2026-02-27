# Guardian — Figma Widget

Figma widget that places the Guardian mascot on the canvas. Clicking it opens the full Guardian plugin UI.

## Purpose

This package is the **widget entry point**: it appears in Figma's **Widgets** panel and can be inserted onto any canvas. It is a companion to `packages/figma-plugin` — both expose the same Guardian interface, just through different Figma entry points.

The widget uses a **combined manifest** (`containsWidget: true`) so that clicking it can open a plugin-style UI panel via `figma.showUI()`. That UI is the exact same `ui.html` as the standalone plugin.

## Architecture

```
figma-widget/
├── manifest.json         — Combined manifest (containsWidget: true)
│                           main: dist/code.js  |  ui: dist/ui.html
├── widget-src/
│   └── code.tsx          — Widget source: mascot SVG, layout, onClick handler
│                           imports bridge.ts from figma-plugin/
├── build.mjs             — Combined build script (see below)
├── tsconfig.json         — For IDE / type-checking only (esbuild handles the build)
├── package.json
└── dist/                 — All generated, gitignored
    ├── code.js           — Widget + plugin code merged
    └── ui.html           — Copied from figma-plugin/ui.html
```

**Build pipeline (`build.mjs`):**

```
figma-plugin/code.ts  ──esbuild──▶  figma-plugin/dist/code.js  ─┐
  + figma-plugin/bridge.ts                                        │
widget-src/code.tsx   ──esbuild (in-memory)──▶  widget bundle   ─┤
  + figma-plugin/bridge.ts (imported)                             ▼
                                                     dist/code.js (merged)

figma-plugin/ui.html  ──copy──────────────────▶  dist/ui.html
```

The merged `dist/code.js` uses a runtime context guard:

```js
// Widget code — always runs (widget.register is a no-op in plugin context)
widget.register(GuardianWidget)

// Plugin code — only runs when opened via Plugins menu (standalone mode)
if (typeof figma.openPlugin === 'function') {
  // figma-plugin/dist/code.js content
}
```

**Shared bridge (`figma-plugin/bridge.ts`):**

Both `code.ts` and `code.tsx` import from the same `bridge.ts`:

| Function | Role |
|---|---|
| `sendFigpalInit()` | Handshake — notifies webapp it's inside Figma |
| `setupPageChangeListener()` | Streams page changes to the UI |
| `handleBasicMessage()` | Handles `close` / `resize` / `notify` messages |
| `buildNodeUrl()` | Builds a Figma node URL from a node ID |

The only intentional difference: `selectionchange` sends full node data + exported image in plugin mode, lightweight payload (no image) in widget mode.

**onClick flow:**

```
User clicks widget on canvas
  → onClick() → figma.showUI(__html__, { width: 400, height: 800 })
                  __html__ = dist/ui.html  (same as the standalone plugin)
  → sendFigpalInit() + initial selection + event listeners set up
  → Guardian panel opens — functionally identical to opening the plugin directly
```

**Communication with the plugin** (when both are loaded):

Two independent channels are used:

| Channel | What it carries | How |
|---|---|---|
| `figma.root.setSharedPluginData` | Widget connectivity status (connected / disconnected) | Direct Figma API — no backend required |
| `/api/figma-bridge?key=<fileKey>` | Webapp-level state (AI context, selections, etc.) | HTTP calls made by the iframe webapp |

The plugin writes its status to `sharedPluginData` on open and on close. The widget reads it inside `useEffect` on every re-render (triggered by any canvas interaction). Status is therefore **eventually consistent**, not real-time — see the platform limitations section in `figma-plugin/README.md` for the full explanation.

## Setup

Dependencies are managed at the monorepo root. From the repo root:

```bash
pnpm install
```

## Scripts

```bash
pnpm build    # one-shot: build plugin (esbuild) + bundle widget (esbuild) → dist/
pnpm dev      # watch: compiles plugin once, then esbuild watches widget-src/
              # run `pnpm dev` in figma-plugin/ in parallel to also watch plugin changes
```

**Running both in parallel (recommended for active development):**

```bash
# Terminal 1
cd packages/figma-plugin && pnpm dev   # esbuild --watch on plugin

# Terminal 2
cd packages/figma-widget && pnpm dev   # esbuild watches widget, fs.watch picks up plugin changes
```

No conflict: each side has its own esbuild process. The widget's `fs.watch` on `figma-plugin/dist/` triggers a re-merge whenever the plugin rebuilds.

## Loading in Figma

1. Open Figma Desktop
2. **Plugins** → **Development** → **Import plugin from manifest…**
3. Select `packages/figma-widget/manifest.json`
4. Insert the widget from **Widgets** → **Development** → **Guardian**
5. Click the mascot on canvas to open the Guardian panel

> To use the plugin directly (without placing a widget), load `packages/figma-plugin/manifest.json` instead — it appears in the **Plugins** menu.

## Important notes

- **Do not edit `dist/` files** — they are regenerated on every build.
- **Do not edit `ui.html` at the package root** — it does not exist; the UI lives in `figma-plugin/ui.html` and is copied to `dist/ui.html` at build time.
- The widget and plugin have **different Figma IDs** and appear as two separate items in Figma. They share `bridge.ts` and `ui.html` only at build time.
- `figma.openPlugin()` does not exist in the widget API — that's why the combined manifest approach is used.
- **A widget with no open UI is completely inert.** Real-time detection of the standalone plugin opening/closing is impossible. See the full platform limitations in `figma-plugin/README.md`.
