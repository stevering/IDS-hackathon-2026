import { GUARDIAN_SVG } from "../shared/guardian-svg";
import type { ClientInfo, FigmaMessage } from "@guardian/bridge";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ElectronAPI {
  onHoverChange: (callback: (isOver: boolean) => void) => void;
  onBridgeClients: (callback: (clients: ClientInfo[]) => void) => void;
  onBridgeMessage: (callback: (clientId: string, msg: FigmaMessage) => void) => void;
  bridgeSend: (clientId: string, msg: unknown) => void;
  bridgeBroadcast: (msg: unknown) => void;
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

// Figma connection indicator — small dot shown on the mascot when Figma is connected
const figmaDot = document.createElement("div");
figmaDot.className = "figma-dot hidden";
figmaDot.title = "Figma connecté";

wrapper.appendChild(guardian);
wrapper.appendChild(badge);
wrapper.appendChild(figmaDot);
root.appendChild(wrapper);

// ── MCP WebSocket (alerts from AI agent) ─────────────────────────────────────

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
      handleMcpMessage(msg);
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

function handleMcpMessage(msg: McpMessage): void {
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

// ── Bridge: Figma client state ────────────────────────────────────────────────

let figmaClients: ClientInfo[] = [];

function updateFigmaState(clients: ClientInfo[]): void {
  figmaClients = clients;
  const hasClients = clients.length > 0;

  figmaDot.classList.toggle("hidden", !hasClients);
  guardian.classList.toggle("figma-connected", hasClients);

  if (hasClients) {
    const types = clients.map((c) => c.clientType).join(", ");
    figmaDot.title = `Figma connecté (${types})`;
    // Brief pulse animation to signal the connection change
    guardian.style.filter = "drop-shadow(0 4px 20px rgba(99,102,241,0.9))";
    setTimeout(() => {
      guardian.style.filter = "";
    }, 800);
  }
}

window.electronAPI.onBridgeClients((clients) => {
  updateFigmaState(clients);
});

window.electronAPI.onBridgeMessage((clientId, msg) => {
  // React to messages coming from Figma
  if (msg.type === "SELECTION_CHANGED") {
    const count = msg.nodes?.length ?? 0;
    if (count > 0) {
      // Brief glow to signal the selection update
      guardian.style.filter = "drop-shadow(0 4px 16px rgba(99,102,241,0.6))";
      setTimeout(() => {
        guardian.style.filter = "";
      }, 400);
    }
  } else if (msg.type === "ANALYSIS_RESULT") {
    const issues = msg.issues ?? [];
    if (issues.length > 0) {
      alertCount += issues.length;
      badge.textContent = String(alertCount);
      badge.classList.remove("hidden");
      guardian.style.filter = "drop-shadow(0 6px 32px rgba(239,68,68,0.8))";
      setTimeout(() => {
        guardian.style.filter = "";
      }, 600);
    }
  } else if (msg.type === "PONG") {
    console.log(`[guardian] Figma client ${clientId} is alive`);
  }
});

// ── Hover state from main process ─────────────────────────────────────────────
// Drag is handled natively via -webkit-app-region:drag in overlay.css.
// The main process polls cursor position and notifies us only for visual feedback.

window.electronAPI.onHoverChange((isOver) => {
  guardian.classList.toggle("hovered", isOver);
});
