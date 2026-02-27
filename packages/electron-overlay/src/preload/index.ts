import { contextBridge, ipcRenderer } from "electron";
import type { ClientInfo, FigmaMessage } from "@guardian/bridge";

contextBridge.exposeInMainWorld("electronAPI", {
  // ── Hover state ──────────────────────────────────────────────────────────
  onHoverChange: (callback: (isOver: boolean) => void): void => {
    ipcRenderer.on("hover-change", (_event, isOver: boolean) =>
      callback(isOver)
    );
  },

  // ── Bridge: Figma client list ────────────────────────────────────────────
  onBridgeClients: (callback: (clients: ClientInfo[]) => void): void => {
    ipcRenderer.on("bridge-clients", (_event, clients: ClientInfo[]) =>
      callback(clients)
    );
  },

  // ── Bridge: messages from Figma ─────────────────────────────────────────
  onBridgeMessage: (
    callback: (clientId: string, msg: FigmaMessage) => void
  ): void => {
    ipcRenderer.on(
      "bridge-message",
      (_event, clientId: string, msg: FigmaMessage) => callback(clientId, msg)
    );
  },

  // ── Bridge: send to Figma ────────────────────────────────────────────────
  bridgeSend: (clientId: string, msg: unknown): void => {
    ipcRenderer.send("bridge-send", clientId, msg);
  },

  bridgeBroadcast: (msg: unknown): void => {
    ipcRenderer.send("bridge-broadcast", msg);
  },

  // ── System status (Figma process detection) ──────────────────────────────
  onSystemStatus: (callback: (status: { figmaRunning: boolean }) => void): void => {
    ipcRenderer.on("system-status", (_event, status: { figmaRunning: boolean }) =>
      callback(status)
    );
  },

  // ── Onboarding panel show/hide (initiated by main) ───────────────────────
  onShowOnboarding: (callback: () => void): void => {
    ipcRenderer.on("show-onboarding", () => callback());
  },

  onHideOnboarding: (callback: () => void): void => {
    ipcRenderer.on("hide-onboarding", () => callback());
  },

  // ── Figma / plugin actions ────────────────────────────────────────────────
  openFigma: (): Promise<void> => ipcRenderer.invoke("open-figma"),

  launchPlugin: (): Promise<{ success: boolean; method: string; error?: string }> =>
    ipcRenderer.invoke("launch-plugin"),

  // ── Overlay panel resize ──────────────────────────────────────────────────
  expandOverlay: (): void => ipcRenderer.send("expand-overlay"),
  collapseOverlay: (): void => ipcRenderer.send("collapse-overlay"),

  // ── Console forwarding → main terminal ──────────────────────────────────
  logToMain: (level: string, ...args: unknown[]): void => {
    ipcRenderer.send("renderer-log", level, ...args);
  },
});
