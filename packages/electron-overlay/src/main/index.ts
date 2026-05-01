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
import { GuardianBridge, getOrCreateFingerprint, loadBridgeConfig, type BridgeConfig } from "./mcp-bridge.js";
import {
  handleDeepLinkCallback,
  refreshAccessToken,
  revokeRefreshToken,
  startPairingFlow,
  type TokenResponse,
} from "./oauth.js";
import {
  clearSession,
  getSessionEmail,
  isAccessTokenExpired,
  loadSession,
  saveSession,
  type StoredSession,
} from "./session-store.js";
import { hostname } from "node:os";
import path from "path";

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
let mcpBridge: GuardianBridge | null = null;

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

// ── Deep-link protocol (RFC 8252 — OAuth 2.0 for Native Apps) ───────────────
// `guardian://oauth/callback?code=...&state=...` routes back to this app.
//
// Platform notes:
//  - macOS: works out of the box (Info.plist CFBundleURLTypes auto-written by
//    electron-builder from package.json build.protocols, or at runtime via the
//    setAsDefaultProtocolClient call below for dev/unpackaged).
//  - Windows: requires the app to be installed (registry entry). In dev,
//    pass process.execPath + argv[1] explicitly so the handler resolves.
//  - Linux: needs a .desktop file registering the MIME handler.
if (process.defaultApp) {
  // Dev / unpackaged: pass the script path explicitly so the OS knows which
  // command to launch when the protocol is invoked.
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("guardian", process.execPath, [
      path.resolve(process.argv[1]!),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("guardian");
}

// Single instance lock — prevent multiple overlays running at once
if (!app.requestSingleInstanceLock()) {
  console.log("[guardian] Another instance is already running — exiting.");
  app.quit();
  process.exit(0);
}

// Windows/Linux: a second instance fires when the OS delivers a guardian://
// URL to an already-running app. The URL is in argv.
app.on("second-instance", (_event, argv) => {
  overlayWin?.show();
  const deepLink = argv.find((a) => a.startsWith("guardian://"));
  if (deepLink) {
    handleDeepLinkCallback(deepLink).catch((e) =>
      console.error("[guardian] deep-link handler failed:", e),
    );
  }
});

// macOS: deep links are delivered via the open-url event, not argv.
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLinkCallback(url).catch((e) =>
    console.error("[guardian] open-url handler failed:", e),
  );
});

app.whenReady().then(() => {
  // macOS: hide from Dock and Cmd+Tab switcher
  if (process.platform === "darwin") {
    app.dock.hide();
  }

  // Load persisted settings
  const settings = loadSettings();
  devToolsOpen = settings.devToolsOpen;

  // Start the Figma bridge server (local WebSocket for plugin/widget)
  bridgeServer.start();
  setupBridgeHandlers();

  // Start the Guardian MCP Bridge — prefer stored OAuth session, else env vars.
  bootBridge().catch((err) =>
    console.error("[guardian] MCP Bridge boot failed (non-fatal):", err),
  );

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

app.on("before-quit", () => {
  mcpBridge?.stop().catch(() => {});
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
      // Preload is forced to CommonJS in electron.vite.config.ts (sandbox:true
      // can't load ESM via require). Output goes to out/preload/index.js.
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

// ── Connection-status menu helpers ────────────────────────────────────────────
// Used by both the right-click context menu and the tray menu so the two stay
// in sync. One item per Figma plugin, one item per local MCP service.

function formatCloudItem(session: StoredSession | null): Electron.MenuItemConstructorOptions {
  // "Connected" is the state the user cares about: cloud reachable AND signed in.
  // /api/guardian/status responds without auth, so isCloudConnected alone would
  // mislead — saying "connected" while the user is actually unauthenticated.
  if (!isCloudConnected) {
    return { label: "○ Guardian Cloud — offline", enabled: false };
  }
  if (!session) {
    return { label: "○ Guardian Cloud — sign in required", enabled: false };
  }
  return { label: "● Guardian Cloud — connected", enabled: false };
}

function formatFigmaPluginItems(): Electron.MenuItemConstructorOptions[] {
  // Note: in cloud mode the plugin's ui.html skips the local WebSocket bridge,
  // so this list is always empty against preview/prod even if a plugin is open.
  // See internal backlog: overlay-plugin-presence-cloud-mode.md
  const clients = bridgeServer.getClients();
  if (clients.length === 0) {
    return [{ label: "○ No Figma plugin detected", enabled: false }];
  }
  return clients.map((c) => {
    if (c.clientType === "widget") {
      const id = c.widgetId ? c.widgetId.slice(-6) : "?";
      return { label: `● Figma widget #${id}`, enabled: false };
    }
    // The plugin re-REGISTERs with fileName/fileKey once its file context is
    // available. Prefer the human-readable fileName; fall back to a truncated
    // fileKey, then to a plain "connected" if the manifest doesn't expose
    // either (the public Figma plugin manifest hides figma.fileKey).
    const fileSuffix = c.fileName
      ? ` · ${c.fileName}`
      : c.fileKey
        ? ` · ${c.fileKey.slice(0, 8)}`
        : " connected";
    return { label: `● Figma plugin${fileSuffix}`, enabled: false };
  });
}

function formatLocalServiceItems(): Electron.MenuItemConstructorOptions[] {
  const status = mcpBridge?.getStatus();
  if (!status || status.instances.length === 0) {
    return [{ label: "○ No local services detected", enabled: false }];
  }
  return status.instances.map((inst) => {
    if (inst.online) {
      return {
        label: `● ${inst.label} — ${inst.toolCount} tool${inst.toolCount === 1 ? "" : "s"}`,
        enabled: false,
      };
    }
    return {
      label: inst.error
        ? `○ ${inst.label} — error`
        : `○ ${inst.label} — offline`,
      enabled: false,
    };
  });
}

// ── Context menu (right-click on overlay) ────────────────────────────────────

function buildContextMenu(): Menu {
  const clients = bridgeServer.getClients();

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

  const ctxSession = loadSession(app.getPath("userData"));
  const ctxEmail = ctxSession ? getSessionEmail(ctxSession) : null;

  return Menu.buildFromTemplate([
    { label: "DS AI Guardian", enabled: false },
    ...(ctxSession
      ? [{ label: ctxEmail ? `Signed in as ${ctxEmail}` : "Signed in", enabled: false }]
      : [{ label: "Not signed in", enabled: false }]),
    { type: "separator" },
    { label: "Connections:", enabled: false },
    formatCloudItem(ctxSession),
    ...formatFigmaPluginItems(),
    ...formatLocalServiceItems(),
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
  const session = loadSession(app.getPath("userData"));
  const sessionEmail = session ? getSessionEmail(session) : null;
  const accountItem: Electron.MenuItemConstructorOptions | null = session
    ? { label: sessionEmail ? `Signed in as ${sessionEmail}` : "Signed in", enabled: false }
    : null;
  const authItem: Electron.MenuItemConstructorOptions = session
    ? { label: "Sign out of Guardian", click: () => { signOut().catch(() => {}); } }
    : { label: "Connect to Guardian…", click: () => { runPairing().catch(() => {}); } };

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
    ...(accountItem ? [accountItem] : []),
    authItem,
    { type: "separator" },
    { label: "Connections:", enabled: false },
    formatCloudItem(session),
    ...formatFigmaPluginItems(),
    ...formatLocalServiceItems(),
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

// ── OAuth pairing + session lifecycle ────────────────────────────────────────

function sessionToBridgeConfig(session: StoredSession, userDataPath: string): BridgeConfig {
  return {
    userId: session.user_id,
    deviceId: session.device_id ?? "",
    deviceFingerprint: getOrCreateFingerprint(userDataPath),
    supabaseUrl: session.supabase_url,
    supabaseAnonKey: session.supabase_anon_key,
    accessToken: session.access_token,
    supabaseRefreshToken: session.supabase_refresh_token,
    instances: [],
  };
}

function storeTokens(tokens: TokenResponse): StoredSession {
  const session: StoredSession = {
    access_token: tokens.access_token,
    supabase_refresh_token: tokens.supabase_refresh_token,
    refresh_token: tokens.refresh_token,
    user_id: tokens.user_id,
    device_id: tokens.device_id,
    scope: tokens.scope,
    access_token_expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
    cloud_url: CLOUD_URL,
    supabase_url: tokens.supabase_url,
    supabase_anon_key: tokens.supabase_anon_key,
    saved_at: Date.now(),
  };
  saveSession(app.getPath("userData"), session);
  return session;
}

async function ensureFreshSession(session: StoredSession): Promise<StoredSession> {
  if (!isAccessTokenExpired(session)) return session;
  console.log("[guardian] Access token expired, refreshing…");
  try {
    const tokens = await refreshAccessToken({
      cloudUrl: session.cloud_url,
      refreshToken: session.refresh_token,
    });
    return storeTokens(tokens);
  } catch (e) {
    console.error("[guardian] Refresh failed, clearing session:", e);
    clearSession(app.getPath("userData"));
    throw e;
  }
}

async function startBridgeFromSession(session: StoredSession): Promise<void> {
  if (mcpBridge) {
    await mcpBridge.stop().catch(() => {});
    mcpBridge = null;
  }
  const config = sessionToBridgeConfig(session, app.getPath("userData"));
  mcpBridge = new GuardianBridge(config);
  await mcpBridge.start();
  refreshTrayMenu();
}

async function bootBridge(): Promise<void> {
  const userDataPath = app.getPath("userData");
  const stored = loadSession(userDataPath);

  if (stored) {
    try {
      const fresh = await ensureFreshSession(stored);
      await startBridgeFromSession(fresh);
      console.log("[guardian] Bridge started from stored OAuth session");
      return;
    } catch (e) {
      console.error("[guardian] Stored session unusable:", e);
      // Fall through to env-var mode.
    }
  }

  // Fallback: env-var dev mode (keeps local testing working without OAuth).
  const envConfig = loadBridgeConfig(userDataPath);
  if (envConfig) {
    mcpBridge = new GuardianBridge(envConfig);
    await mcpBridge.start();
    console.log("[guardian] Bridge started from env vars");
    refreshTrayMenu();
    return;
  }

  console.log(
    "[guardian] No OAuth session and no env vars — click 'Connect to Guardian' in the panel to pair",
  );
  refreshTrayMenu();
}

async function runPairing(): Promise<void> {
  try {
    const tokens = await startPairingFlow({
      cloudUrl: CLOUD_URL,
      deviceFingerprint: getOrCreateFingerprint(app.getPath("userData")),
      deviceName: hostname(),
    });
    const session = storeTokens(tokens);
    await startBridgeFromSession(session);
    overlayWin?.webContents.send("guardian-auth", { authenticated: true, user_id: session.user_id });
    console.log("[guardian] Paired successfully");
  } catch (e) {
    overlayWin?.webContents.send("guardian-auth", {
      authenticated: false,
      error: (e as Error).message,
    });
    console.error("[guardian] Pairing failed:", e);
  }
}

async function signOut(): Promise<void> {
  const userDataPath = app.getPath("userData");
  const stored = loadSession(userDataPath);
  if (stored) {
    await revokeRefreshToken({
      cloudUrl: stored.cloud_url,
      refreshToken: stored.refresh_token,
    });
  }
  clearSession(userDataPath);
  if (mcpBridge) {
    await mcpBridge.stop().catch(() => {});
    mcpBridge = null;
  }
  overlayWin?.webContents.send("guardian-auth", { authenticated: false });
  refreshTrayMenu();
}

ipcMain.handle("guardian-start-pairing", async () => {
  await runPairing();
});

ipcMain.handle("guardian-sign-out", async () => {
  await signOut();
});

ipcMain.handle("guardian-session-status", () => {
  const session = loadSession(app.getPath("userData"));
  return session
    ? { authenticated: true, user_id: session.user_id, device_id: session.device_id }
    : { authenticated: false };
});

// Renderer console → main terminal (for debugging without opening DevTools)
ipcMain.on("renderer-log", (_event, level: string, ...args: unknown[]) => {
  const prefix = `[renderer/${level}]`;
  if (level === "error") console.error(prefix, ...args);
  else if (level === "warn") console.warn(prefix, ...args);
  else console.log(prefix, ...args);
});
