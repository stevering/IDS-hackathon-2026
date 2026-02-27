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
  openFigma: () => Promise<void>;
  launchPlugin: () => Promise<{ success: boolean; method: string; error?: string }>;
  expandOverlay: () => void;
  collapseOverlay: () => void;
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

// ── Mascot section ────────────────────────────────────────────────────────────

const mascotSection = document.createElement("div");
mascotSection.className = "mascot-section";

const wrapper = document.createElement("div");
wrapper.style.position = "relative";

const guardian = document.createElement("div");
guardian.className = "guardian";
guardian.innerHTML = GUARDIAN_SVG;

const badge = document.createElement("div");
badge.className = "alert-badge hidden";
badge.textContent = "0";

const figmaDot = document.createElement("div");
figmaDot.className = "figma-dot hidden";
figmaDot.title = "Plugin Figma connecté";

const mcpDot = document.createElement("div");
mcpDot.className = "mcp-dot";
mcpDot.title = "Agent IA non connecté";

wrapper.appendChild(guardian);
wrapper.appendChild(badge);
wrapper.appendChild(figmaDot);
wrapper.appendChild(mcpDot);
mascotSection.appendChild(wrapper);

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
// Guard: only start the timer if the preload is actually loaded.
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

  // Safety reset — always re-enable within 4 s regardless of IPC outcome
  const reset = (): void => {
    openFigmaBtn.textContent = "Open Figma ↗";
    openFigmaBtn.disabled = false;
  };
  const safetyTimer = setTimeout(reset, 4000);

  try {
    window.electronAPI.openFigma()
      .finally(() => { clearTimeout(safetyTimer); reset(); });
  } catch (err) {
    // openFigma undefined or threw synchronously
    console.error("[guardian] openFigma failed:", err);
    clearTimeout(safetyTimer);
    reset();
  }
});

// Step 2 — "I have a file open" acknowledgement
const haveFileBtn = document.getElementById("btn-have-file") as HTMLButtonElement;
haveFileBtn.addEventListener("click", () => {
  step2Done = true;
  updateAllSteps();
});

// Step 3 — open Figma quick actions (Cmd+/) so the user can type "Guardian"
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
        // Figma is now in the foreground — show the shortcut prominently
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
    mcpDot.classList.add("connected");
    mcpDot.classList.remove("reconnecting");
    mcpDot.title = "Agent IA connecté";
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
    mcpDot.classList.remove("connected");
    mcpDot.classList.add("reconnecting");
    mcpDot.title = "Agent IA — reconnexion…";
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    mcpDot.classList.remove("connected");
    mcpDot.classList.add("reconnecting");
    mcpDot.title = "Agent IA non connecté";
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

  figmaDot.classList.toggle("hidden", !hasClients);
  guardian.classList.toggle("figma-connected", hasClients);

  if (hasClients) {
    const types = clients.map((c) => c.clientType).join(", ");
    figmaDot.title = `Figma connecté (${types})`;
    guardian.style.filter = "drop-shadow(0 4px 20px rgba(99,102,241,0.9))";
    setTimeout(() => { guardian.style.filter = ""; }, 800);

    // Step 3 complete — bridge connected!
    if (!step3Done) {
      step3Done = true;
      updateAllSteps();
      const desc = document.getElementById("step-3-desc");
      if (desc) desc.textContent = "Connected! Guardian is live ✓";

      // Cancel pending auto-show
      if (autoShowTimer !== null) {
        clearTimeout(autoShowTimer);
        autoShowTimer = null;
      }

      // Auto-dismiss the onboarding panel after showing success briefly
      if (onboardingVisible) {
        setTimeout(() => hideOnboarding(), 1500);
      }
    }
  } else {
    // All clients disconnected — reset step 3
    step3Done = false;
    updateAllSteps();
    const desc = document.getElementById("step-3-desc");
    if (desc) desc.textContent = "Waiting for plugin…";
  }
}

// ── Electron IPC subscriptions (only when preload is loaded) ─────────────────

if (window.electronAPI) {
  // Forward renderer console → main terminal so logs appear in `pnpm dev` output
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
        guardian.style.filter = "drop-shadow(0 4px 16px rgba(99,102,241,0.6))";
        setTimeout(() => { guardian.style.filter = ""; }, 400);
      }
    } else if (msg.type === "ANALYSIS_RESULT") {
      const issues = msg.issues ?? [];
      if (issues.length > 0) {
        alertCount += issues.length;
        badge.textContent = String(alertCount);
        badge.classList.remove("hidden");
        guardian.style.filter = "drop-shadow(0 6px 32px rgba(239,68,68,0.8))";
        setTimeout(() => { guardian.style.filter = ""; }, 600);
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
}

// ── Mascot click → toggle onboarding ─────────────────────────────────────────
// Note: .guardian has -webkit-app-region:drag so click may not always fire,
// but a quick tap (no drag) reliably triggers the event when the window is focused.

mascotSection.addEventListener("click", () => {
  if (onboardingVisible) hideOnboarding();
  else showOnboarding();
});
