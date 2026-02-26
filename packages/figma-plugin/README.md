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

Both the plugin and the widget UI can exchange state through the webapp backend:

```
Plugin UI  →  POST /api/figma-bridge?key=<fileKey>  →  Backend store
Widget UI  →  GET  /api/figma-bridge?key=<fileKey>  →  reads state
```

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
