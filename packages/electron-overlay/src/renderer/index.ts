import { GUARDIAN_SVG } from "../shared/guardian-svg";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ElectronAPI {
  onHoverChange: (callback: (isOver: boolean) => void) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// ── Incoming MCP message shape ────────────────────────────────────────────────

interface McpMessage {
  type: "ALERT" | "CLEAR_ALERTS" | "PING";
  count?: number;
  text?: string;
}

// ── DOM setup ─────────────────────────────────────────────────────────────────

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root");

const wrapper = document.createElement("div");
wrapper.style.position = "relative";

const guardian = document.createElement("div");
guardian.className = "guardian";
guardian.innerHTML = GUARDIAN_SVG;

const badge = document.createElement("div");
badge.className = "alert-badge hidden";
badge.textContent = "0";

wrapper.appendChild(guardian);
wrapper.appendChild(badge);
root.appendChild(wrapper);

// ── MCP WebSocket ─────────────────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);
const WS_PORT = Number(params.get("wsPort") ?? 3001);
const WS_URL = `ws://localhost:${WS_PORT}`;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let alertCount = 0;

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    guardian.classList.add("connected");
    guardian.classList.remove("error");
    ws?.send(JSON.stringify({ type: "REGISTER", client: "electron-overlay" }));
  });

  ws.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const msg = JSON.parse(event.data) as McpMessage;
      handleMessage(msg);
    } catch {
      // ignore malformed messages
    }
  });

  ws.addEventListener("close", () => {
    guardian.classList.remove("connected");
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    guardian.classList.add("error");
    guardian.classList.remove("connected");
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

function handleMessage(msg: McpMessage): void {
  if (msg.type === "ALERT") {
    alertCount = msg.count ?? alertCount + 1;
    badge.textContent = String(alertCount);
    badge.classList.remove("hidden");
    guardian.style.filter = "drop-shadow(0 6px 32px rgba(239,68,68,0.8))";
    setTimeout(() => {
      guardian.style.filter = "";
    }, 600);
  } else if (msg.type === "CLEAR_ALERTS") {
    alertCount = 0;
    badge.classList.add("hidden");
  }
}

connect();

// ── Hover state from main process ─────────────────────────────────────────────
// Drag is handled natively via -webkit-app-region:drag in overlay.css.
// The main process polls cursor position and notifies us only for visual feedback.

window.electronAPI.onHoverChange((isOver) => {
  guardian.classList.toggle("hovered", isOver);
});
