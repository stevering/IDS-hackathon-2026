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
├── build.mjs             — Combined build script (see below)
├── tsconfig.json         — For IDE / type-checking only (esbuild handles the build)
├── package.json
└── dist/                 — All generated, gitignored
    ├── code.js           — Widget + plugin code merged
    └── ui.html           — Copied from figma-plugin/ui.html
```

**Build pipeline (`build.mjs`):**

```
figma-plugin/code.ts  ──tsc──────────────────▶  figma-plugin/code.js  ─┐
widget-src/code.tsx   ──esbuild (in-memory)──▶  widget bundle          ─┤
                                                                          ▼
                                                           dist/code.js (merged)

figma-plugin/ui.html  ──copy──────────────────▶  dist/ui.html
```

The merged `dist/code.js` uses a runtime context guard:

```js
// Widget code — always runs (widget.register is a no-op in plugin context)
widget.register(GuardianWidget)

// Plugin code — only runs when opened as a plugin (onClick handler context)
if (typeof figma.openPlugin === 'function') {
  // figma-plugin/code.js content
}
```

**onClick flow:**

```
User clicks widget on canvas
  → onClick() → figma.showUI(__html__, { width: 400, height: 800 })
                  __html__ = dist/ui.html  (same as the standalone plugin)
  → Guardian panel opens — identical to opening the plugin directly
```

**Communication with the plugin** (when both are loaded):

Widget UI and plugin UI share state through the webapp backend — no `figma.clientStorage` coupling:

```
Widget UI  →  POST /api/figma-bridge?key=<fileKey>  →  Backend store
Plugin UI  →  GET  /api/figma-bridge?key=<fileKey>  →  reads state
```

## Setup

Dependencies are managed at the monorepo root. From the repo root:

```bash
pnpm install
```

## Scripts

```bash
pnpm build    # one-shot: compile plugin (tsc) + widget (esbuild) → dist/
pnpm dev      # watch: esbuild watches widget-src/, tsc --watch watches figma-plugin/code.ts
              #        any change in either source rebuilds dist/code.js automatically
```

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
- The widget and plugin have **different Figma IDs** and appear as two separate items in Figma. They share code only at build time.
