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

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ── Constants ────────────────────────────────────────────────────────────────

const OVERLAY_SIZE = 100; // px — size of the floating mascot
const MARGIN = 24; // px — margin from screen edge
const WS_PORT = Number(process.env["GUARDIAN_WS_PORT"] ?? 3001);

// ── State ────────────────────────────────────────────────────────────────────

let overlayWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let isVisible = true;

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
  // webContents.on('context-menu') fires in the main process when the user
  // right-clicks inside the renderer, regardless of JS event listeners.
  overlayWin.webContents.on("context-menu", () => {
    if (overlayWin === null) return;
    const menu = Menu.buildFromTemplate([
      {
        label: isVisible ? "Hide Guardian" : "Show Guardian",
        click: () => toggleVisibility(),
      },
      { type: "separator" },
      { label: "Quit Guardian", click: () => app.quit() },
    ]);
    menu.popup({ window: overlayWin });
  });

  // Load the renderer
  if (process.env["ELECTRON_RENDERER_URL"] != null) {
    void overlayWin.loadURL(
      `${process.env["ELECTRON_RENDERER_URL"]}?wsPort=${WS_PORT}`
    );
  } else {
    void overlayWin.loadFile(join(__dirname, "../renderer/index.html"), {
      query: { wsPort: String(WS_PORT) },
    });
  }
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
  return Menu.buildFromTemplate([
    {
      label: isVisible ? "Hide Guardian" : "Show Guardian",
      click: () => toggleVisibility(),
    },
    { type: "separator" },
    { label: `MCP: ws://localhost:${WS_PORT}`, enabled: false },
    { type: "separator" },
    { label: "Quit Guardian", click: () => app.quit() },
  ]);
}

function toggleVisibility(): void {
  if (overlayWin === null) return;
  isVisible = !isVisible;
  isVisible ? overlayWin.show() : overlayWin.hide();
  tray?.setContextMenu(buildTrayMenu());
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on("show-context-menu", () => {
  if (overlayWin === null) return;
  const menu = Menu.buildFromTemplate([
    {
      label: isVisible ? "Hide Guardian" : "Show Guardian",
      click: () => toggleVisibility(),
    },
    { type: "separator" },
    { label: "Quit Guardian", click: () => app.quit() },
  ]);
  menu.popup({ window: overlayWin });
});
