import { GUARDIAN_SVG } from "../shared/guardian-svg";
import type { ClientInfo, FigmaMessage } from "@guardian/bridge";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ElectronAPI {
  onHoverChange: (callback: (isOver: boolean) => void) => void;
  onBridgeClients: (callback: (clients: ClientInfo[]) => void) => void;
  onBridgeMessage: (callback: (clientId: string, msg: FigmaMessage) => void) => void;
  bridgeSend: (clientId: string, msg: unknown) => void;
  bridgeBroadcast: (msg: unknown) => void;
  onSystemStatus: (callback: (status: { figmaRunning: boolean }) => void) => void;
  onShowOnboarding: (callback: () => void) => void;
  onHideOnboarding: (callback: () => void) => void;
  onMessageSide: (callback: (side: "left" | "right") => void) => void;
  reportMcpStatus: (connected: boolean) => void;
  openFigma: () => Promise<void>;
  launchPlugin: () => Promise<{ success: boolean; method: string; error?: string }>;
  expandOverlay: () => void;
  collapseOverlay: () => void;
  expandForMessage: () => void;
  collapseForMessage: () => void;
  logToMain: (level: string, ...args: unknown[]) => void;
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

// ── Onboarding panel ──────────────────────────────────────────────────────────

const onboarding = document.createElement("div");
onboarding.className = "onboarding hidden";
onboarding.innerHTML = `
  <div class="ob-card">
    <div class="ob-header">
      <div class="ob-title">🛡 Setup Guardian</div>
      <button class="ob-close" title="Close">✕</button>
    </div>
    <p class="ob-subtitle">Connect Figma in 3 quick steps</p>

    <div class="ob-steps">
      <div class="ob-step" id="ob-step-1">
        <div class="step-ind" data-n="1">1</div>
        <div class="step-body">
          <div class="step-title">Open Figma</div>
          <div class="step-desc">Launch the Figma desktop app</div>
          <button class="step-btn" id="btn-open-figma">Open Figma ↗</button>
        </div>
      </div>

      <div class="ob-step dimmed" id="ob-step-2">
        <div class="step-ind" data-n="2">2</div>
        <div class="step-body">
          <div class="step-title">Open a design file</div>
          <div class="step-desc">Guardian only works inside a Figma file — open or create one</div>
          <button class="step-btn" id="btn-have-file">I have a file open →</button>
        </div>
      </div>

      <div class="ob-step dimmed" id="ob-step-3">
        <div class="step-ind" data-n="3">3</div>
        <div class="step-body">
          <div class="step-title">Start Guardian Plugin</div>
          <div class="step-desc" id="step-3-desc">Click to focus Figma, then press Cmd+/, type "Guardian" and Enter</div>
          <button class="step-btn" id="btn-launch-plugin">Focus Figma ↗</button>
        </div>
      </div>
    </div>
  </div>
`;

// ── Mascot section (flex row: [bubble] [mascot] or [mascot] [bubble]) ─────────

const mascotSection = document.createElement("div");
mascotSection.className = "mascot-section";

// ── Message bubble ─────────────────────────────────────────────────────────────

const messageBubble = document.createElement("div");
messageBubble.className = "message-bubble hidden";

const bubbleIcon = document.createElement("div");
bubbleIcon.className = "bubble-icon";

const bubbleContent = document.createElement("div");
bubbleContent.className = "bubble-content";

const bubbleType = document.createElement("div");
bubbleType.className = "bubble-type";

const messageText = document.createElement("div");
messageText.className = "message-text";

bubbleContent.appendChild(bubbleType);
bubbleContent.appendChild(messageText);

const messageAction = document.createElement("button");
messageAction.className = "message-action";
messageAction.title = "Analyser avec Guardian";
messageAction.innerHTML = `
  <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2.5c0 0 .9 4 2.8 5.5C16.7 9.5 21 9.5 21 9.5s-4.3.1-6.2 1.6C12.9 12.5 12 16.5 12 16.5s-.9-4-2.8-5.5C7.3 9.6 3 9.5 3 9.5s4.3 0 6.2-1.5C11.1 6.5 12 2.5 12 2.5z"/>
    <path d="M19.5 15c0 0 .5 2 1.5 2.7 1 .7 2.5.8 2.5.8s-1.5 0-2.5.8c-1 .7-1.5 2.7-1.5 2.7s-.5-2-1.5-2.7c-1-.7-2.5-.8-2.5-.8s1.5-.1 2.5-.8c1-.7 1.5-2.7 1.5-2.7z"/>
  </svg>
`;

messageBubble.appendChild(bubbleIcon);
messageBubble.appendChild(bubbleContent);
messageBubble.appendChild(messageAction);

// ── Mascot wrapper (100×100, contains guardian + status dots) ─────────────────

const mascotWrapper = document.createElement("div");
mascotWrapper.className = "mascot-wrapper";

const guardian = document.createElement("div");
guardian.className = "guardian";
guardian.innerHTML = GUARDIAN_SVG;

const badge = document.createElement("div");
badge.className = "alert-badge hidden";
badge.textContent = "0";

const figmaDot = document.createElement("div");
figmaDot.className = "figma-dot";

const mcpDot = document.createElement("div");
mcpDot.className = "mcp-dot";

// ── Status tooltip (shows on dot hover, positioned inside the window) ─────────

const statusTooltip = document.createElement("div");
statusTooltip.className = "status-tooltip";

mascotWrapper.appendChild(guardian);
mascotWrapper.appendChild(badge);
mascotWrapper.appendChild(figmaDot);
mascotWrapper.appendChild(mcpDot);
mascotWrapper.appendChild(statusTooltip);

// Dot hover → custom tooltip (native title= doesn't work on transparent overlays)
figmaDot.addEventListener("mouseenter", () => {
  if (figmaDot.classList.contains("connected")) {
    const count = figmaClients.length;
    statusTooltip.textContent = `Figma — ${count} client${count > 1 ? "s" : ""}`;
  } else if (figmaDot.classList.contains("failed")) {
    statusTooltip.textContent = "Figma — plugin introuvable";
  } else {
    statusTooltip.textContent = "Figma — en attente";
  }
  statusTooltip.classList.add("visible");
});
figmaDot.addEventListener("mouseleave", () => statusTooltip.classList.remove("visible"));

mcpDot.addEventListener("mouseenter", () => {
  if (mcpDot.classList.contains("connected")) {
    statusTooltip.textContent = "MCP — connecté";
  } else if (mcpDot.classList.contains("failed")) {
    statusTooltip.textContent = "MCP — hors ligne";
  } else if (mcpDot.classList.contains("reconnecting")) {
    statusTooltip.textContent = "MCP — reconnexion";
  } else {
    statusTooltip.textContent = "MCP — en attente";
  }
  statusTooltip.classList.add("visible");
});
mcpDot.addEventListener("mouseleave", () => statusTooltip.classList.remove("visible"));

// Prevent dot clicks from bubbling up to mascotWrapper's onboarding toggle
figmaDot.addEventListener("click", (e) => e.stopPropagation());
mcpDot.addEventListener("click", (e) => e.stopPropagation());

// Default layout: [bubble (left)] [mascot (right)] — flipped to row-reverse for bubble-right
mascotSection.appendChild(messageBubble);
mascotSection.appendChild(mascotWrapper);

root.appendChild(onboarding);
root.appendChild(mascotSection);

// ── Onboarding state ──────────────────────────────────────────────────────────

let step1Done = false; // Figma is running
let step2Done = false; // Plugin launch triggered
let step3Done = false; // Bridge client connected
let onboardingVisible = false;
let autoShowTimer: ReturnType<typeof setTimeout> | null = null;
let figmaClients: ClientInfo[] = []; // declared early — used in auto-show timer callback

function applyStepState(stepId: string, done: boolean, active: boolean): void {
  const el = document.getElementById(stepId);
  if (!el) return;
  const ind = el.querySelector<HTMLElement>(".step-ind");
  if (!ind) return;

  el.classList.toggle("dimmed", !done && !active);

  if (done) {
    ind.className = "step-ind done";
    ind.textContent = "✓";
  } else {
    ind.className = `step-ind${active ? " active" : ""}`;
    ind.textContent = ind.dataset["n"] ?? "";
  }
}

function updateAllSteps(): void {
  applyStepState("ob-step-1", step1Done, true);              // step 1: always active
  applyStepState("ob-step-2", step2Done, step1Done);         // step 2: active when figma open
  applyStepState("ob-step-3", step3Done, step2Done);         // step 3: active when plugin launched
}

function showOnboarding(): void {
  if (onboardingVisible) return;
  onboardingVisible = true;
  onboarding.classList.remove("hidden");
  window.electronAPI.expandOverlay();
}

function hideOnboarding(): void {
  if (!onboardingVisible) return;
  onboardingVisible = false;
  onboarding.classList.add("hidden");
  window.electronAPI.collapseOverlay();
}

// Auto-show after 3 s if no Figma clients have connected.
if (window.electronAPI) {
  autoShowTimer = setTimeout(() => {
    autoShowTimer = null;
    if (figmaClients.length === 0) {
      showOnboarding();
    }
  }, 3000);
}

// ── Onboarding button handlers ────────────────────────────────────────────────

const closeBtn = onboarding.querySelector<HTMLButtonElement>(".ob-close")!;
closeBtn.addEventListener("click", () => hideOnboarding());

const openFigmaBtn = document.getElementById("btn-open-figma") as HTMLButtonElement;
openFigmaBtn.addEventListener("click", () => {
  openFigmaBtn.textContent = "Opening…";
  openFigmaBtn.disabled = true;

  const reset = (): void => {
    openFigmaBtn.textContent = "Open Figma ↗";
    openFigmaBtn.disabled = false;
  };
  const safetyTimer = setTimeout(reset, 4000);

  try {
    window.electronAPI.openFigma()
      .finally(() => { clearTimeout(safetyTimer); reset(); });
  } catch (err) {
    console.error("[guardian] openFigma failed:", err);
    clearTimeout(safetyTimer);
    reset();
  }
});

const haveFileBtn = document.getElementById("btn-have-file") as HTMLButtonElement;
haveFileBtn.addEventListener("click", () => {
  step2Done = true;
  updateAllSteps();
});

const launchPluginBtn = document.getElementById("btn-launch-plugin") as HTMLButtonElement;
launchPluginBtn.addEventListener("click", () => {
  console.log("[guardian] btn-launch-plugin clicked — step2Done:", step2Done, "electronAPI:", !!window.electronAPI);

  launchPluginBtn.textContent = "Opening…";
  launchPluginBtn.disabled = true;

  const setDesc = (text: string): void => {
    const el = document.getElementById("step-3-desc");
    if (el) el.textContent = text;
  };

  const resetLaunch = (): void => {
    launchPluginBtn.textContent = "Focus Figma ↗";
    launchPluginBtn.disabled = false;
  };
  const safetyTimer = setTimeout(() => {
    console.warn("[guardian] launchPlugin safety timer fired — no response from main");
    resetLaunch();
  }, 6000);

  try {
    window.electronAPI.launchPlugin().then((result) => {
      clearTimeout(safetyTimer);
      console.log("[guardian] launchPlugin result:", result);

      if (result.method === "activated") {
        setDesc('✦ Figma is focused — press Cmd+/, type "Guardian", press Enter');
        resetLaunch();
      } else if (result.method === "needs-accessibility") {
        setDesc("⚠ Grant Accessibility in System Settings → Privacy → Accessibility, then retry");
        resetLaunch();
      } else {
        setDesc('Could not focus Figma — switch to it manually, then press Cmd+/');
        resetLaunch();
      }
    }).catch((err: unknown) => {
      clearTimeout(safetyTimer);
      console.error("[guardian] launchPlugin rejected:", err);
      setDesc('Switch to Figma manually, then press Cmd+/, type "Guardian", Enter');
      resetLaunch();
    });
  } catch (err) {
    console.error("[guardian] launchPlugin threw:", err);
    clearTimeout(safetyTimer);
    setDesc('window.electronAPI.launchPlugin unavailable — check preload');
    resetLaunch();
  }
});

// ── Main-initiated show/hide ──────────────────────────────────────────────────

if (window.electronAPI) {
  window.electronAPI.onShowOnboarding(() => showOnboarding());
  window.electronAPI.onHideOnboarding(() => hideOnboarding());
}

// ── Message display state ─────────────────────────────────────────────────────

let currentMessage: string | null = null;
let messageTimer: ReturnType<typeof setTimeout> | null = null;

// ── Node type helpers ─────────────────────────────────────────────────────────

function getNodeEmoji(type?: string): string {
  switch (type?.toUpperCase()) {
    case "FRAME":     return "⬜";
    case "COMPONENT": return "⬡";
    case "INSTANCE":  return "◈";
    case "TEXT":      return "T";
    case "RECTANGLE": return "▭";
    case "ELLIPSE":   return "○";
    case "GROUP":     return "❑";
    case "VECTOR":    return "✦";
    default:          return "◉";
  }
}

function formatNodeType(type?: string): string {
  if (!type) return "";
  // Convert SCREAMING_CASE to Title Case
  return type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");
}

// ── Message bubble functions ──────────────────────────────────────────────────

function showMessage(name: string, nodeType?: string): void {
  currentMessage = name;

  // Update bubble content
  bubbleIcon.textContent = getNodeEmoji(nodeType);
  bubbleType.textContent = nodeType ? formatNodeType(nodeType) : "";
  bubbleType.style.display = nodeType ? "" : "none";
  messageText.textContent = name;

  // 1. Expand window first (instant, animate:false) so the bubble appears in
  //    the wide window rather than briefly squishing the mascot in the 100px one.
  window.electronAPI.expandForMessage();

  // 2. Bring element into layout (display:flex, opacity still 0 from base rule).
  messageBubble.classList.remove("hidden");

  // 3. Force a reflow so the transition starts from opacity:0, not from nothing.
  void messageBubble.offsetWidth;

  // 4. Trigger fade-in transition.
  messageBubble.classList.add("visible");

  // Auto-hide after 8 seconds
  if (messageTimer !== null) clearTimeout(messageTimer);
  messageTimer = setTimeout(() => hideMessage(), 8000);
}

function hideMessage(): void {
  if (messageTimer !== null) {
    clearTimeout(messageTimer);
    messageTimer = null;
  }
  currentMessage = null;

  // 1. Trigger CSS fade-out (opacity 1→0 over 0.22s).
  messageBubble.classList.remove("visible");

  // 2. After the transition completes: remove from layout + collapse window.
  //    The window collapses instantly (animate:false) after the bubble is invisible.
  setTimeout(() => {
    messageBubble.classList.add("hidden");
    window.electronAPI.collapseForMessage();
  }, 240);
}

// ── Figma dot state helpers ───────────────────────────────────────────────────

const FIGMA_FAIL_TIMEOUT = 15_000; // 15 s without any plugin → red
let figmaFailTimer: ReturnType<typeof setTimeout> | null = null;

function setFigmaDotState(state: "idle" | "connected" | "failed"): void {
  figmaDot.classList.toggle("connected", state === "connected");
  figmaDot.classList.toggle("failed",    state === "failed");
}

function scheduleFigmaFail(): void {
  if (figmaFailTimer !== null) return;
  figmaFailTimer = setTimeout(() => {
    figmaFailTimer = null;
    setFigmaDotState("failed");
  }, FIGMA_FAIL_TIMEOUT);
}

function clearFigmaFailTimer(): void {
  if (figmaFailTimer !== null) {
    clearTimeout(figmaFailTimer);
    figmaFailTimer = null;
  }
}

// Start counting from page load
scheduleFigmaFail();

// ── MCP WebSocket (alerts from AI agent) ─────────────────────────────────────

const params = new URLSearchParams(window.location.search);
const WS_PORT = Number(params.get("wsPort") ?? 3001);
const WS_URL = `ws://localhost:${WS_PORT}`;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectCount = 0;
const MCP_FAIL_AFTER = 3; // consecutive failures → red dot
let alertCount = 0;

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    reconnectCount = 0;
    mcpDot.classList.add("connected");
    mcpDot.classList.remove("reconnecting", "failed");
    ws?.send(JSON.stringify({ type: "REGISTER", client: "electron-overlay" }));
    window.electronAPI.reportMcpStatus(true);
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
    reconnectCount++;
    mcpDot.classList.remove("connected");
    if (reconnectCount >= MCP_FAIL_AFTER) {
      mcpDot.classList.add("failed");
      mcpDot.classList.remove("reconnecting");
    } else {
      mcpDot.classList.add("reconnecting");
      mcpDot.classList.remove("failed");
    }
    window.electronAPI.reportMcpStatus(false);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    mcpDot.classList.remove("connected");
    // Let the close handler manage state transitions
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
    setTimeout(() => { guardian.style.filter = ""; }, 600);
  } else if (msg.type === "CLEAR_ALERTS") {
    alertCount = 0;
    badge.classList.add("hidden");
  }
}

connect();

// ── Bridge: Figma client state ────────────────────────────────────────────────

function updateFigmaState(clients: ClientInfo[]): void {
  figmaClients = clients;
  const hasClients = clients.length > 0;

  guardian.classList.toggle("figma-connected", hasClients);

  if (hasClients) {
    clearFigmaFailTimer();
    setFigmaDotState("connected");
    guardian.style.filter = "drop-shadow(0 4px 20px rgba(34,211,238,0.7))";
    setTimeout(() => { guardian.style.filter = ""; }, 800);

    // Step 3 complete — bridge connected!
    if (!step3Done) {
      step3Done = true;
      updateAllSteps();
      const desc = document.getElementById("step-3-desc");
      if (desc) desc.textContent = "Connected! Guardian is live ✓";

      if (autoShowTimer !== null) {
        clearTimeout(autoShowTimer);
        autoShowTimer = null;
      }

      if (onboardingVisible) {
        setTimeout(() => hideOnboarding(), 1500);
      }
    }
  } else {
    setFigmaDotState("idle");
    scheduleFigmaFail();
    step3Done = false;
    updateAllSteps();
    const desc = document.getElementById("step-3-desc");
    if (desc) desc.textContent = "Waiting for plugin…";
  }
}

// ── Electron IPC subscriptions ────────────────────────────────────────────────

if (window.electronAPI) {
  // Forward renderer console → main terminal
  const _log = console.log.bind(console);
  const _warn = console.warn.bind(console);
  const _error = console.error.bind(console);
  const fwd = (level: string, orig: (...a: unknown[]) => void, ...args: unknown[]): void => {
    orig(...args);
    window.electronAPI.logToMain(level, ...args.map(a =>
      a instanceof Error ? a.message : typeof a === "object" ? JSON.stringify(a) : String(a)
    ));
  };
  console.log   = (...a) => fwd("log",   _log,   ...a);
  console.warn  = (...a) => fwd("warn",  _warn,  ...a);
  console.error = (...a) => fwd("error", _error, ...a);

  window.electronAPI.onBridgeClients((clients) => {
    updateFigmaState(clients);
  });

  window.electronAPI.onBridgeMessage((clientId, msg) => {
    if (msg.type === "SELECTION_CHANGED") {
      const count = msg.nodes?.length ?? 0;
      if (count > 0) {
        // Indigo glow on selection change
        guardian.style.filter = "drop-shadow(0 4px 16px rgba(99,102,241,0.6))";
        setTimeout(() => { guardian.style.filter = ""; }, 400);

        const firstNode = msg.nodes[0];
        const nodeName = firstNode?.name || "element";
        const nodeType = firstNode?.type || undefined;

        // Truncate long names
        const displayName = nodeName.length > 32
          ? nodeName.substring(0, 32) + "…"
          : nodeName;

        const label = count === 1
          ? displayName
          : `${displayName} + ${count - 1} more`;

        showMessage(label, count === 1 ? nodeType : undefined);
      } else {
        hideMessage();
      }
    } else if (msg.type === "ANALYSIS_RESULT") {
      const issues = msg.issues ?? [];
      if (issues.length > 0) {
        alertCount += issues.length;
        badge.textContent = String(alertCount);
        badge.classList.remove("hidden");
        guardian.style.filter = "drop-shadow(0 6px 32px rgba(239,68,68,0.8))";
        setTimeout(() => { guardian.style.filter = ""; }, 600);

        const issueCount = issues.length;
        showMessage(
          issueCount === 1 ? "1 issue detected" : `${issueCount} issues detected`,
          undefined
        );
      }
    } else if (msg.type === "PONG") {
      console.log(`[guardian] Figma client ${clientId} is alive`);
    }
  });

  window.electronAPI.onSystemStatus((status) => {
    if (status.figmaRunning !== step1Done) {
      step1Done = status.figmaRunning;
      updateAllSteps();
    }
  });

  window.electronAPI.onHoverChange((isOver) => {
    guardian.classList.toggle("hovered", isOver);
  });

  // Handle message side from main process (left = bubble to left of mascot)
  window.electronAPI.onMessageSide((side) => {
    mascotSection.classList.toggle("bubble-right", side === "right");
  });
}

// ── Mascot click → toggle onboarding ─────────────────────────────────────────

mascotWrapper.addEventListener("click", () => {
  if (onboardingVisible) hideOnboarding();
  else showOnboarding();
});

// ── Message action button: open plugin + new conversation ─────────────────────

messageAction.addEventListener("click", (e) => {
  e.stopPropagation();
  e.preventDefault();

  if (figmaClients.length > 0) {
    // Plugin already open → ask it to start a new conversation
    window.electronAPI.bridgeBroadcast({ type: "OPEN_PLUGIN_AND_CONVERSE" });
  } else {
    // Plugin not open → try to launch Figma + plugin
    void window.electronAPI.launchPlugin();
  }

  hideMessage();
});
