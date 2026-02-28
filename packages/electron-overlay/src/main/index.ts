import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  shell,
  systemPreferences,
} from "electron";
import { join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { BridgeServer } from "@guardian/bridge";
import type { ClientInfo } from "@guardian/bridge";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ── Constants ────────────────────────────────────────────────────────────────

const OVERLAY_SIZE = 100; // px — compact mascot
const PANEL_WIDTH  = 320; // px — onboarding panel width
const PANEL_HEIGHT = 420; // px — onboarding panel height
const MESSAGE_WIDTH = 400; // px — width when showing message bubble
const MARGIN = 24;        // px — margin from screen edge
const BRIDGE_PORT = Number(process.env["GUARDIAN_BRIDGE_PORT"] ?? 3002);
const CLOUD_URL = process.env["GUARDIAN_CLOUD_URL"] ?? "http://localhost:3000";

// ── Persistent settings ──────────────────────────────────────────────────────

interface GuardianSettings {
  devToolsOpen: boolean;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "guardian-settings.json");
}

function loadSettings(): GuardianSettings {
  try {
    return { devToolsOpen: false, ...JSON.parse(readFileSync(settingsPath(), "utf-8")) };
  } catch {
    return { devToolsOpen: false };
  }
}

function saveSettings(s: GuardianSettings): void {
  try { writeFileSync(settingsPath(), JSON.stringify(s)); } catch { /* ignore */ }
}

// ── State ────────────────────────────────────────────────────────────────────

let overlayWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let isVisible = true;
let isPanelExpanded = false;
let isMessageExpanded = false;
let messageSide: "left" | "right" = "left";

// ── Position tracking ─────────────────────────────────────────────────────────
// Each "expand" saves the compact position so the matching "collapse" can restore it.
// We never rely on getBounds() at collapse-time because the window may be mid-animation.

/** Compact position saved just before expandOverlay(). Restored by collapseOverlay(). */
let preOverlayBounds: { x: number; y: number } | null = null;

/**
 * Target compact position stored by collapseForMessage().
 * Used by the NEXT expandForMessage() when it fires before the collapse animation
 * finishes — getBounds() would return a mid-animation value at that point.
 * Expires after COLLAPSE_ANIM_TTL ms so a subsequent user drag is honoured.
 */
let lastCollapseTarget: { x: number; y: number; ts: number } | null = null;
const COLLAPSE_ANIM_TTL = 600; // ms — comfortably longer than any macOS window anim

let devToolsOpen = false; // loaded from settings after app ready
let isCloudConnected = false; // updated via IPC from renderer's HTTP health check
const bridgeServer = new BridgeServer(BRIDGE_PORT);

// ── Position helpers ─────────────────────────────────────────────────────────

/**
 * Clamp a compact (100×100) window position so the mascot is always fully
 * visible on screen with at least MARGIN px clearance on every side.
 */
function clampCompactPos(x: number, y: number): { x: number; y: number } {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    x: Math.max(MARGIN, Math.min(x, width  - OVERLAY_SIZE - MARGIN)),
    y: Math.max(MARGIN, Math.min(y, height - OVERLAY_SIZE - MARGIN)),
  };
}

// ── Error handling ───────────────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("[guardian] uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[guardian] unhandledRejection:", reason);
});

// ── App lifecycle ────────────────────────────────────────────────────────────

// Single instance lock — prevent multiple overlays running at once
if (!app.requestSingleInstanceLock()) {
  console.log("[guardian] Another instance is already running — exiting.");
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  overlayWin?.show();
});

app.whenReady().then(() => {
  // macOS: hide from Dock and Cmd+Tab switcher
  if (process.platform === "darwin") {
    app.dock.hide();
  }

  // Load persisted settings
  const settings = loadSettings();
  devToolsOpen = settings.devToolsOpen;

  // Start the Figma bridge server
  bridgeServer.start();
  setupBridgeHandlers();

  createOverlay();
  try {
    createTray();
  } catch (err) {
    console.error("[guardian] Tray creation failed (non-fatal):", err);
  }

  startFigmaPolling();
});

app.on("window-all-closed", () => {
  // Keep the app alive even if all windows are closed (tray app pattern)
});

// ── Figma detection ──────────────────────────────────────────────────────────

function isFigmaRunning(): boolean {
  try {
    execSync("pgrep -x Figma", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

let _lastFigmaRunning = false;

function startFigmaPolling(): void {
  // Send initial status once the renderer has loaded
  overlayWin?.webContents.on("did-finish-load", () => {
    const running = isFigmaRunning();
    _lastFigmaRunning = running;
    overlayWin?.webContents.send("system-status", { figmaRunning: running });
  });

  // Poll every 3 s and only send on state change (reduces IPC noise)
  setInterval(() => {
    const running = isFigmaRunning();
    if (running !== _lastFigmaRunning) {
      _lastFigmaRunning = running;
      overlayWin?.webContents.send("system-status", { figmaRunning: running });
    }
  }, 3000);
}

// ── Plugin launcher ──────────────────────────────────────────────────────────

async function openFigma(): Promise<void> {
  await shell.openExternal("figma://");
}

async function launchPlugin(): Promise<{ success: boolean; method: string; error?: string }> {
  console.log("[guardian] launchPlugin() called");

  if (process.platform !== "darwin") {
    return { success: false, method: "unsupported", error: "macOS only" };
  }

  // Check macOS Accessibility permission — required for keystroke automation
  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  console.log("[guardian] Accessibility trusted:", trusted);

  if (!trusted) {
    // Prompt the user to grant permission (opens System Settings dialog)
    systemPreferences.isTrustedAccessibilityClient(true);
    return { success: false, method: "needs-accessibility", error: "Accessibility permission required — grant it in System Settings > Privacy > Accessibility, then retry" };
  }

  try {
    // Just bring Figma to the foreground — keystroke injection via System Events
    // is unreliable on Electron/Chromium apps (Figma). The renderer will show
    // a clear Cmd+/ reminder once Figma is focused.
    console.log("[guardian] Activating Figma…");
    execSync(
      `osascript -e 'tell application "Figma" to activate'`,
      { stdio: "pipe", timeout: 3000 }
    );
    console.log("[guardian] Figma activated");
    return { success: true, method: "activated" };
  } catch (err) {
    console.error("[guardian] Could not activate Figma:", err);
    return { success: false, method: "failed", error: String(err) };
  }
}

// ── Overlay resize ───────────────────────────────────────────────────────────

function expandOverlay(): void {
  if (!overlayWin || isPanelExpanded) return;
  isPanelExpanded = true;

  // Save the compact position so collapseOverlay() can restore it later.
  // When a message is expanded, derive the compact position from the current
  // window bounds (mascot is at one known edge of the expanded window).
  if (isMessageExpanded) {
    const b = overlayWin.getBounds();
    const compactX = messageSide === "left"
      ? b.x + b.width - OVERLAY_SIZE   // mascot at right end
      : b.x;                            // mascot at left end
    preOverlayBounds = { x: compactX, y: b.y };
    isMessageExpanded = false;
    lastCollapseTarget = null;
  } else {
    const b = overlayWin.getBounds();
    preOverlayBounds = { x: b.x, y: b.y };
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  overlayWin.setBounds(
    { x: width - PANEL_WIDTH - MARGIN, y: height - PANEL_HEIGHT - MARGIN, width: PANEL_WIDTH, height: PANEL_HEIGHT },
    true
  );
}

function toggleDevTools(): void {
  if (!overlayWin) return;
  devToolsOpen = !devToolsOpen;
  saveSettings({ devToolsOpen });
  if (devToolsOpen) {
    overlayWin.webContents.openDevTools({ mode: "detach" });
  } else {
    overlayWin.webContents.closeDevTools();
  }
  refreshTrayMenu();
}

function collapseOverlay(): void {
  if (!overlayWin || !isPanelExpanded) return;
  isPanelExpanded = false;

  // A message bubble is managing the window — don't override its position.
  if (isMessageExpanded) return;

  // Restore the compact position that was saved when the panel opened.
  // Falls back to the default bottom-right corner only on the very first use.
  const restore = preOverlayBounds;
  preOverlayBounds = null;

  if (restore) {
    const clamped = clampCompactPos(restore.x, restore.y);
    overlayWin.setBounds(
      { x: clamped.x, y: clamped.y, width: OVERLAY_SIZE, height: OVERLAY_SIZE },
      true
    );
  } else {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    overlayWin.setBounds(
      { x: width - OVERLAY_SIZE - MARGIN, y: height - OVERLAY_SIZE - MARGIN, width: OVERLAY_SIZE, height: OVERLAY_SIZE },
      true
    );
  }
}

function expandForMessage(): void {
  if (!overlayWin || isPanelExpanded || isMessageExpanded) return;
  isMessageExpanded = true;

  // ── Resolve compact position ─────────────────────────────────────────────────
  // If a collapse just fired (< COLLAPSE_ANIM_TTL ms ago) the window is still
  // animating — getBounds() returns a mid-frame value. Reuse the stored target.
  const useTarget = lastCollapseTarget && (Date.now() - lastCollapseTarget.ts < COLLAPSE_ANIM_TTL);
  const compact = useTarget ? lastCollapseTarget! : overlayWin.getBounds();
  lastCollapseTarget = null;

  // ── Choose expansion direction ───────────────────────────────────────────────
  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;
  const compactCenterX = compact.x + OVERLAY_SIZE / 2;
  const isOnRightSide = compactCenterX > screenWidth / 2;

  let newX: number;
  if (isOnRightSide) {
    newX = Math.max(MARGIN, compact.x + OVERLAY_SIZE - MESSAGE_WIDTH);
    messageSide = "left";
  } else {
    newX = compact.x;
    messageSide = "right";
  }

  // animate: false → instant resize, no CoreAnimation jitter on mascot position
  overlayWin.setBounds({ x: newX, y: compact.y, width: MESSAGE_WIDTH, height: OVERLAY_SIZE }, false);
  overlayWin.webContents.send("message-side", messageSide);
}

function collapseForMessage(): void {
  if (!overlayWin || !isMessageExpanded) return;
  isMessageExpanded = false;

  // ── Compute mascot's compact position from CURRENT bounds ────────────────────
  // The mascot is always pinned to one edge of the expanded window.
  // Using getBounds() here (not a pre-captured snapshot) means any drag the user
  // performed while the bubble was open is fully respected — the mascot stays
  // exactly where the user left it.
  const b = overlayWin.getBounds();
  const restore = messageSide === "left"
    ? { x: b.x + b.width - OVERLAY_SIZE, y: b.y }   // mascot at right end
    : { x: b.x, y: b.y };                             // mascot at left end

  // Clamp so the mascot can't end up outside the screen (e.g. after a drag
  // that moved the expanded window near or past a screen edge).
  const clamped = clampCompactPos(restore.x, restore.y);

  // Store so rapid re-expand can use the correct target instead of a mid-anim value.
  lastCollapseTarget = { x: clamped.x, y: clamped.y, ts: Date.now() };

  // animate: false → instant resize, no CoreAnimation jitter on mascot position
  overlayWin.setBounds(
    { x: clamped.x, y: clamped.y, width: OVERLAY_SIZE, height: OVERLAY_SIZE },
    false
  );
}

// ── Bridge event handlers ─────────────────────────────────────────────────────

function setupBridgeHandlers(): void {
  bridgeServer.on("client-connected", (client: ClientInfo) => {
    console.log(`[guardian/bridge] Figma ${client.clientType} connected (${client.id})`);
    overlayWin?.webContents.send("bridge-clients", bridgeServer.getClients());
    refreshTrayMenu();
  });

  bridgeServer.on("client-disconnected", (client: ClientInfo) => {
    console.log(`[guardian/bridge] Figma ${client.clientType} disconnected (${client.id})`);
    overlayWin?.webContents.send("bridge-clients", bridgeServer.getClients());
    refreshTrayMenu();
  });

  bridgeServer.on("message", (clientId: string, msg) => {
    // Forward all Figma messages to the renderer for display/reaction
    overlayWin?.webContents.send("bridge-message", clientId, msg);
  });
}

// ── Overlay window ───────────────────────────────────────────────────────────

function createOverlay(): void {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  overlayWin = new BrowserWindow({
    width: OVERLAY_SIZE,
    height: OVERLAY_SIZE,
    x: width - OVERLAY_SIZE - MARGIN,
    y: height - OVERLAY_SIZE - MARGIN,

    // Overlay essentials
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    // movable:true so that -webkit-app-region:drag in the renderer can move the window
    movable: true,
    hasShadow: false,

    // focusable:true required on macOS — false blocks mouse events in the renderer
    focusable: true,

    webPreferences: {
      // electron-vite outputs .mjs when package.json has "type":"module"
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // macOS: float above fullscreen apps (e.g. Figma in fullscreen mode)
  overlayWin.setAlwaysOnTop(true, "floating");

  // Default: click-through. The polling loop below toggles this based on cursor position.
  overlayWin.setIgnoreMouseEvents(true, { forward: true });

  // ── Hit-test polling ──────────────────────────────────────────────────────
  let isOverWindow = false;

  setInterval(() => {
    if (overlayWin === null || !overlayWin.isVisible()) return;

    const cursor = screen.getCursorScreenPoint();
    const bounds = overlayWin.getBounds();

    const over =
      cursor.x >= bounds.x &&
      cursor.x <= bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y <= bounds.y + bounds.height;

    if (over === isOverWindow) return;
    isOverWindow = over;

    overlayWin.setIgnoreMouseEvents(!over, { forward: true });
    overlayWin.webContents.send("hover-change", over);
  }, 50);

  // ── Clamp after user drag ─────────────────────────────────────────────────
  // -webkit-app-region:drag lets the user move the window freely, including
  // partially off-screen. Debounce on 'moved' so we clamp once the drag ends.
  let moveClampTimer: ReturnType<typeof setTimeout> | null = null;
  overlayWin.on("moved", () => {
    if (isPanelExpanded || isMessageExpanded) return; // only in compact mode
    if (moveClampTimer !== null) clearTimeout(moveClampTimer);
    moveClampTimer = setTimeout(() => {
      moveClampTimer = null;
      if (!overlayWin || isPanelExpanded || isMessageExpanded) return;
      const b = overlayWin.getBounds();
      const clamped = clampCompactPos(b.x, b.y);
      if (clamped.x !== b.x || clamped.y !== b.y) {
        overlayWin.setBounds({ x: clamped.x, y: clamped.y, width: OVERLAY_SIZE, height: OVERLAY_SIZE }, true);
      }
    }, 200);
  });

  // Auto-open DevTools if enabled in settings
  overlayWin.webContents.on("did-finish-load", () => {
    if (devToolsOpen) overlayWin?.webContents.openDevTools({ mode: "detach" });
  });

  // ── Right-click context menu ──────────────────────────────────────────────
  overlayWin.webContents.on("context-menu", () => {
    buildContextMenu().popup({ window: overlayWin! });
  });

  // Load the renderer
  if (process.env["ELECTRON_RENDERER_URL"] != null) {
    void overlayWin.loadURL(
      `${process.env["ELECTRON_RENDERER_URL"]}?bridgePort=${BRIDGE_PORT}&cloudUrl=${encodeURIComponent(CLOUD_URL)}`
    );
  } else {
    void overlayWin.loadFile(join(__dirname, "../renderer/index.html"), {
      query: { bridgePort: String(BRIDGE_PORT), cloudUrl: CLOUD_URL },
    });
  }
}

// ── Context menu (right-click on overlay) ────────────────────────────────────

function buildContextMenu(): Menu {
  const clients = bridgeServer.getClients();

  const figmaItems: Electron.MenuItemConstructorOptions[] =
    clients.length > 0
      ? clients.map((c) => ({
          label: `● ${c.clientType === "widget" ? "Widget" : "Plugin"}${
            c.widgetId ? " #" + c.widgetId.slice(-6) : ""
          }${c.fileKey ? "  ·  " + c.fileKey.slice(0, 8) : ""}`,
          enabled: false,
        }))
      : [{ label: "○ No Figma client connected", enabled: false }];

  const sendItems: Electron.MenuItemConstructorOptions[] =
    clients.length > 0
      ? [
          {
            label: "Send to Figma…",
            submenu: [
              {
                label: "Analyze selection",
                click: () => bridgeServer.broadcast({ type: "TRIGGER_ANALYSIS" }),
              },
              {
                label: "Create a test Frame",
                click: () =>
                  bridgeServer.broadcast({
                    type: "EXECUTE_CODE",
                    id: "test-frame",
                    code: `
const f = figma.createFrame();
f.name = "Guardian Frame";
f.x = figma.viewport.center.x;
f.y = figma.viewport.center.y;
f.resize(200, 200);
figma.currentPage.appendChild(f);
figma.currentPage.selection = [f];
figma.viewport.scrollAndZoomIntoView([f]);`,
                  }),
              },
              {
                label: "Ping Figma",
                click: () => bridgeServer.broadcast({ type: "PING" }),
              },
            ],
          },
        ]
      : [];

  const cloudLabel = isCloudConnected
    ? `● Guardian Cloud — connected`
    : `○ Guardian Cloud — offline`;

  const bridgeLabel = clients.length > 0
    ? `● Bridge  ws:${BRIDGE_PORT}  — ${clients.length} client${clients.length > 1 ? "s" : ""}`
    : `○ Bridge  ws:${BRIDGE_PORT}  — waiting`;

  return Menu.buildFromTemplate([
    { label: "DS AI Guardian", enabled: false },
    { type: "separator" },
    { label: "Servers:", enabled: false },
    { label: cloudLabel, enabled: false },
    { label: bridgeLabel, enabled: false },
    { type: "separator" },
    { label: "Figma:", enabled: false },
    ...figmaItems,
    ...(sendItems.length > 0 ? [{ type: "separator" as const }, ...sendItems] : []),
    { type: "separator" },
    {
      label: isPanelExpanded ? "Close panel" : "⚙ Setup Figma…",
      click: () => {
        if (isPanelExpanded) {
          collapseOverlay();
          overlayWin?.webContents.send("hide-onboarding");
        } else {
          expandOverlay();
          overlayWin?.webContents.send("show-onboarding");
        }
      },
    },
    {
      label: isVisible ? "Hide Guardian" : "Show Guardian",
      click: () => toggleVisibility(),
    },
    { type: "separator" },
    {
      label: devToolsOpen ? "✓ DevTools (renderer)" : "DevTools (renderer)",
      click: () => toggleDevTools(),
    },
    { label: "Quit", click: () => app.quit() },
  ]);
}

// ── System tray ──────────────────────────────────────────────────────────────

function createTray(): void {
  // 16×16 solid RGBA buffer — macOS requires a non-empty image for the menu bar
  const SIZE = 16;
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const o = i * 4;
    buf[o] = 100;     // R
    buf[o + 1] = 130; // G
    buf[o + 2] = 220; // B
    buf[o + 3] = 255; // A
  }
  const icon = nativeImage.createFromBuffer(buf, { width: SIZE, height: SIZE });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("DS AI Guardian");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => toggleVisibility());
}

function buildTrayMenu(): Menu {
  const clients = bridgeServer.getClients();

  const figmaItems: Electron.MenuItemConstructorOptions[] =
    clients.length > 0
      ? clients.map((c) => ({
          label: `● ${c.clientType === "widget" ? "Widget" : "Plugin"}${
            c.widgetId ? " #" + c.widgetId.slice(-6) : ""
          }`,
          enabled: false,
        }))
      : [{ label: "○ No Figma connected", enabled: false }];

  const cloudLabelTray = isCloudConnected
    ? `● Guardian Cloud — connected`
    : `○ Guardian Cloud — offline`;

  const bridgeLabelTray = clients.length > 0
    ? `● Bridge  ws:${BRIDGE_PORT}  — ${clients.length} client${clients.length > 1 ? "s" : ""}`
    : `○ Bridge  ws:${BRIDGE_PORT}  — waiting`;

  return Menu.buildFromTemplate([
    {
      label: isVisible ? "Hide Guardian" : "Show Guardian",
      click: () => toggleVisibility(),
    },
    {
      label: isPanelExpanded ? "Close panel" : "⚙ Setup Figma…",
      click: () => {
        if (isPanelExpanded) {
          collapseOverlay();
          overlayWin?.webContents.send("hide-onboarding");
        } else {
          expandOverlay();
          overlayWin?.webContents.send("show-onboarding");
        }
      },
    },
    { type: "separator" },
    { label: "Servers:", enabled: false },
    { label: cloudLabelTray, enabled: false },
    { label: bridgeLabelTray, enabled: false },
    { type: "separator" },
    { label: "Figma:", enabled: false },
    ...figmaItems,
    { type: "separator" },
    {
      label: devToolsOpen ? "✓ DevTools (renderer)" : "DevTools (renderer)",
      click: () => toggleDevTools(),
    },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(buildTrayMenu());
}

function toggleVisibility(): void {
  if (overlayWin === null) return;
  isVisible = !isVisible;
  isVisible ? overlayWin.show() : overlayWin.hide();
  refreshTrayMenu();
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on("show-context-menu", () => {
  buildContextMenu().popup({ window: overlayWin! });
});

// Renderer → send a message to a specific Figma client
ipcMain.on("bridge-send", (_event, clientId: string, msg: unknown) => {
  bridgeServer.send(clientId, msg as Parameters<typeof bridgeServer.send>[1]);
});

// Renderer → broadcast a message to all Figma clients
ipcMain.on("bridge-broadcast", (_event, msg: unknown) => {
  bridgeServer.broadcast(msg as Parameters<typeof bridgeServer.broadcast>[0]);
});

// Onboarding panel resize
  ipcMain.on("expand-overlay", () => expandOverlay());
  ipcMain.on("collapse-overlay", () => collapseOverlay());
  ipcMain.on("expand-for-message", () => expandForMessage());
  ipcMain.on("collapse-for-message", () => collapseForMessage());

// Figma / plugin actions (invokable from renderer)
ipcMain.handle("open-figma", () => openFigma());
ipcMain.handle("launch-plugin", () => launchPlugin());

// Renderer → Guardian Cloud status (for tray / context menu display)
ipcMain.on("cloud-status", (_event, connected: boolean) => {
  isCloudConnected = connected;
  refreshTrayMenu();
});

// Renderer console → main terminal (for debugging without opening DevTools)
ipcMain.on("renderer-log", (_event, level: string, ...args: unknown[]) => {
  const prefix = `[renderer/${level}]`;
  if (level === "error") console.error(prefix, ...args);
  else if (level === "warn") console.warn(prefix, ...args);
  else console.log(prefix, ...args);
});
