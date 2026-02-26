import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
} from "electron";
import { join } from "path";
import { fileURLToPath } from "url";
import { BridgeServer } from "@guardian/bridge";
import type { ClientInfo } from "@guardian/bridge";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ── Constants ────────────────────────────────────────────────────────────────

const OVERLAY_SIZE = 100; // px — size of the floating mascot
const MARGIN = 24;        // px — margin from screen edge
const WS_PORT = Number(process.env["GUARDIAN_WS_PORT"] ?? 3001);
const BRIDGE_PORT = Number(process.env["GUARDIAN_BRIDGE_PORT"] ?? 3002);

// ── State ────────────────────────────────────────────────────────────────────

let overlayWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let isVisible = true;
const bridgeServer = new BridgeServer(BRIDGE_PORT);

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

  // Start the Figma bridge server
  bridgeServer.start();
  setupBridgeHandlers();

  createOverlay();
  try {
    createTray();
  } catch (err) {
    console.error("[guardian] Tray creation failed (non-fatal):", err);
  }
});

app.on("window-all-closed", () => {
  // Keep the app alive even if all windows are closed (tray app pattern)
});

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
      preload: join(__dirname, "../preload/index.js"),
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
  // Poll cursor position every 50 ms and toggle setIgnoreMouseEvents so that:
  //   • When the cursor overlaps the window → accept mouse events (enables
  //     -webkit-app-region drag and context-menu).
  //   • When the cursor is elsewhere → pass events through to the app below.
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

  // ── Right-click context menu ──────────────────────────────────────────────
  overlayWin.webContents.on("context-menu", () => {
    buildContextMenu().popup({ window: overlayWin! });
  });

  // Load the renderer
  if (process.env["ELECTRON_RENDERER_URL"] != null) {
    void overlayWin.loadURL(
      `${process.env["ELECTRON_RENDERER_URL"]}?wsPort=${WS_PORT}&bridgePort=${BRIDGE_PORT}`
    );
  } else {
    void overlayWin.loadFile(join(__dirname, "../renderer/index.html"), {
      query: { wsPort: String(WS_PORT), bridgePort: String(BRIDGE_PORT) },
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
      : [{ label: "○ Aucun client Figma connecté", enabled: false }];

  const sendItems: Electron.MenuItemConstructorOptions[] =
    clients.length > 0
      ? [
          {
            label: "Envoyer vers Figma…",
            submenu: [
              {
                label: "Analyser la sélection",
                click: () => bridgeServer.broadcast({ type: "TRIGGER_ANALYSIS" }),
              },
              {
                label: "Créer un Frame test",
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

  return Menu.buildFromTemplate([
    { label: "DS AI Guardian", enabled: false },
    { type: "separator" },
    { label: "Figma Connections :", enabled: false },
    ...figmaItems,
    ...(sendItems.length > 0 ? [{ type: "separator" as const }, ...sendItems] : []),
    { type: "separator" },
    {
      label: isVisible ? "Masquer Guardian" : "Afficher Guardian",
      click: () => toggleVisibility(),
    },
    { label: "Quitter", click: () => app.quit() },
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
      : [{ label: "○ Aucun Figma connecté", enabled: false }];

  return Menu.buildFromTemplate([
    {
      label: isVisible ? "Masquer Guardian" : "Afficher Guardian",
      click: () => toggleVisibility(),
    },
    { type: "separator" },
    { label: "Figma :", enabled: false },
    ...figmaItems,
    { type: "separator" },
    { label: `MCP: ws://localhost:${WS_PORT}`, enabled: false },
    { label: `Bridge: ws://localhost:${BRIDGE_PORT}`, enabled: false },
    { type: "separator" },
    { label: "Quitter", click: () => app.quit() },
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
