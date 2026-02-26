# @guardian/electron-overlay

Floating Guardian mascot — transparent, always-on-top, works above any app (Figma Desktop, Chrome, anything).

## How it works

- Transparent frameless Electron window, always-on-top
- **Click-through by default** — all clicks reach Figma or whatever is below
- **Interactive on hover** — click-through disabled when your mouse is over Guardian
- **Draggable** — grab and move Guardian anywhere on screen
- **Connects to the MCP server** via WebSocket (port 3001 by default)
- Shows a red badge when the MCP server sends an alert
- System tray icon (macOS menu bar / Windows tray) to show/hide/quit

## Start

```bash
# From monorepo root — dev mode (hot reload):
pnpm dev:overlay

# Or directly:
pnpm --filter @guardian/electron-overlay dev
```

## Build

```bash
pnpm --filter @guardian/electron-overlay build
# then
pnpm --filter @guardian/electron-overlay start
```

## Configuration

| Env variable       | Default | Description                          |
|--------------------|---------|--------------------------------------|
| `GUARDIAN_WS_PORT` | `3001`  | WebSocket port of the MCP server     |

```bash
GUARDIAN_WS_PORT=9223 pnpm --filter @guardian/electron-overlay dev
```

## Architecture

```
Electron Main process
  └── BrowserWindow (transparent, always-on-top, 100×100px)
        ↕ contextBridge IPC
  Preload script
        ↕ window.electronAPI
  Renderer (Chromium)
    ├── Guardian SVG + CSS animations
    ├── Hover → setIgnoreMouseEvents(false) → interactive
    ├── Mouse leave → setIgnoreMouseEvents(true) → click-through
    └── WebSocket → MCP server
          ↓ messages
          ALERT       → show red badge on Guardian
          CLEAR_ALERTS → hide badge
```

## MCP message protocol

The overlay listens for JSON messages on the WebSocket:

```jsonc
// Show an alert badge
{ "type": "ALERT", "count": 3, "text": "3 drift issues detected" }

// Clear the badge
{ "type": "CLEAR_ALERTS" }
```

The overlay identifies itself on connect:
```json
{ "type": "REGISTER", "client": "electron-overlay" }
```
