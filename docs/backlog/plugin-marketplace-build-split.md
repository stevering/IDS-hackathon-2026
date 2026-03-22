# Split plugin build for marketplace vs desktop

## Context

The Guardian Figma plugin exists in two variants sharing the same codebase (`code.ts`, `ui.html`, `bridge.ts`):
- **figma-plugin**: To be published on the Figma marketplace. Subject to Figma review.
- **figma-desktop-plugin**: Local-only with `enablePrivatePluginApi: true`. Not published.

Since the FC Bridge compatibility work, the shared code includes features that are desktop-only (FC WS Bridge, console capture, document change listener, Proxy handler). This code is dead weight in the marketplace build and could raise questions during Figma's review process.

## What to exclude from the marketplace build

| Feature | Location | Why exclude |
|---|---|---|
| FC WS Bridge (scanner + 37 adapters + event forwarding) | `ui.html` (~600 lines) | WS blocked by `allowedDomains`, dead code, large surface |
| `window.__connectFCPort` | `ui.html` | Only for Temporal instant connect |
| FigmaProxy Client | `ui.html` (~80 lines) | Only used by FC Bridge adapters |
| `hexToFigmaRGB` helper | `ui.html` | Only used by FC adapters |
| FC Bridge `_fcBroadcast` + event forwarding in onmessage | `ui.html` | DOCUMENT_CHANGE, CONSOLE_CAPTURE, SELECTION_CHANGE broadcast |
| Console capture monkey-patch | `code.ts` (~30 lines) | Overhead, forwards to FC Bridge |
| Document change listener (`loadAllPagesAsync` + `documentchange`) | `code.ts` (~20 lines) | Loads all pages in memory, heavy on large files |
| Proxy handler (7 primitives + handle store) | `code.ts` (~130 lines) | Only used via FC Bridge, not by Guardian directly |
| `teamlibrary` permission | `manifest.json` | Only needed for `importComponentByKeyAsync` (FC INSTANTIATE_COMPONENT) |

## What stays in both builds

| Feature | Reason |
|---|---|
| EXECUTE_CODE handler | Used by Guardian MCP, webapp, Electron overlay |
| get-selection, GET_VARIABLES, get-file-info | Core Guardian features |
| HIGHLIGHT_NODE, notify, storage-get/set | Guardian + Electron overlay |
| Guardian Bridge Client (WS 3002) | Electron overlay communication |
| Webapp iframe + message routing | Core Guardian UI |
| Selection streaming (selectionchange) | Core Guardian feature |
| Page change listener | Core Guardian feature |
| Auth state + login prompt | Core Guardian feature |
| Widget support (GUARDIAN_MODE) | Core Guardian feature |

## Approach: Build-time conditional (`BUILD_TARGET`)

### build.mjs changes

Add a `BUILD_TARGET` env variable:
```bash
BUILD_TARGET=marketplace pnpm --filter @guardian/figma-plugin build
BUILD_TARGET=desktop pnpm --filter @guardian/figma-desktop-plugin build
```

### code.ts — preprocessor comments

Wrap FC-only sections with markers that `build.mjs` strips for marketplace:

```ts
// @FC_ONLY_START
const _proxyHandles = new Map<string, unknown>();
let _proxyHandleCounter = 0;
// ... proxy handler, console capture, document change ...
// @FC_ONLY_END
```

In `build.mjs`, when `BUILD_TARGET=marketplace`:
- Read `code.ts`, strip everything between `@FC_ONLY_START` and `@FC_ONLY_END`
- Or use esbuild `define` to dead-code eliminate: `define: { 'FC_ENABLED': 'false' }` + `if (FC_ENABLED) { ... }`

### ui.html — HTML preprocessor

Trickier since ui.html is not compiled. Options:
- **A) Split into sections**: `ui-core.html` + `ui-fc-bridge.html`. Desktop build concatenates both. Marketplace build uses only core.
- **B) Build script strips markers**: Same `@FC_ONLY_START/@FC_ONLY_END` approach, `build.mjs` processes ui.html for marketplace.
- **C) Runtime check**: `if (window.__GUARDIAN_DESKTOP)` wrapping. Less clean but simpler.

**Recommended: Option B** — consistent with code.ts approach, single source of truth.

### manifest.json — separate files (already separate)

Already separate manifests. Just remove `teamlibrary` from `figma-plugin/manifest.json`:
```json
"permissions": ["currentuser"]
```

### package.json scripts

```json
{
  "build": "BUILD_TARGET=marketplace node build.mjs",
  "build:desktop": "BUILD_TARGET=desktop node build.mjs",
  "dev": "BUILD_TARGET=desktop node build.mjs --watch"
}
```

## Impact estimate

| Metric | Marketplace build | Desktop build |
|---|---|---|
| code.ts (dist/code.js) | ~550 lines removed | No change |
| ui.html | ~700 lines removed | No change |
| Permissions | `currentuser` only | `currentuser, teamlibrary` |
| WS connections | 0 (blocked by manifest) | 10 ports + Electron |

## Verification

1. `BUILD_TARGET=marketplace pnpm build` → verify `dist/code.js` has no Proxy handler, no console capture
2. `BUILD_TARGET=marketplace pnpm build` → verify `ui.html` (or processed copy) has no FC Bridge
3. Run the marketplace build in Figma → verify core Guardian features work (selection, chat, analysis)
4. `BUILD_TARGET=desktop pnpm build` → verify everything works including FC Bridge
5. E2E FC compat tests still pass with desktop build

## Priority

Medium — needed before marketplace submission. Not blocking dev work.
