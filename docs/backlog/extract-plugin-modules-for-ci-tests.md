# Extract plugin modules for CI-compatible unit tests

## Context

The Figma plugin's Proxy handler (code.ts) and FC Bridge adapters (ui.html) are currently inline — not importable as modules. This makes them untestable in CI (no Figma Desktop available).

The existing E2E test (`packages/figma-plugin/tests/fc-compat.test.mjs`) requires a live Figma Desktop instance with the Guardian plugin open.

## Goal

Extract testable modules so unit tests can run in CI (vitest) without Figma Desktop.

## Steps

### 1. Extract Proxy handler from code.ts

Create `packages/figma-plugin/proxy-handler.ts`:
- Handle store (`_proxyHandles` Map)
- All 7 PROXY_* handlers (CALL, GET, SET, SNAPSHOT, ITERATE, CALL_EACH, RELEASE)
- Serialization logic (null → null, symbol → `__FIGMA_MIXED__`, object → handle)

code.ts imports and calls it from `figma.ui.onmessage`.

**Test:** `proxy-handler.test.ts` — mock `figma.*` objects, verify:
- Handle creation and release
- Method calls route to correct objects
- Symbol → `__FIGMA_MIXED__` mapping
- Objects always stored as handles (not serialized)
- Error cases (handle not found, null target)

### 2. Extract FC adapters from ui.html

Create `packages/figma-plugin/fc-adapters.js` (or .ts):
- `hexToFigmaRGB()` helper
- `getNode()` helper
- All 34 `fcMethods` adapters

ui.html imports via `<script type="module">` or inline after esbuild bundle.

**Test:** `fc-adapters.test.ts` — mock `FigmaProxy`, verify:
- Each adapter returns ISO format (`{ success: true, node: {...} }`)
- Error messages match native plugin ("Node not found: <id>", "Node must be a TEXT node. Got: <type>")
- EXECUTE_CODE errors resolve (not reject) with `{ success: false, error }`
- hexToFigmaRGB converts correctly (3/4/6/8 char hex)

### 3. Extract FigmaProxy client from ui.html

Create `packages/figma-plugin/figma-proxy-client.js`:
- `send()`, `handleResult()`, pending tracking, timeout
- All public methods (call, get, set, snapshot, iterate, callForEach, release, executeCode)

**Test:** `figma-proxy-client.test.ts` — mock `postMessage`, verify:
- Pending request tracking (requestId → Promise)
- Timeout fires and rejects
- handleResult resolves correct pending entry
- Error responses reject the Promise
- Undefined values handled correctly (null passthrough)

## Constraints

- esbuild bundles code.ts → dist/code.js. Extracted modules must be importable by esbuild.
- ui.html is not compiled. Extracted JS modules would need to be either inlined at build time or loaded via `<script src>` (but Figma plugin ui.html is a data: URL — no external scripts). Options:
  - Build step that bundles adapters into ui.html
  - Or keep inline but import from the module for tests only (dual source)
- Must not break the existing plugin behavior or build pipeline.

## Priority

Medium — the E2E test covers all functionality today. CI tests add regression safety but aren't blocking.
