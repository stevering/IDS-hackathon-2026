import { contextBridge, ipcRenderer } from "electron";
import type { ClientInfo, FigmaMessage } from "@guardian/bridge";

contextBridge.exposeInMainWorld("electronAPI", {
  // ── Hover state (existing) ───────────────────────────────────────────────
  /**
   * Called by the main process when the cursor enters/leaves the overlay bounds.
   * The renderer uses this to update the hover visual state.
   */
  onHoverChange: (callback: (isOver: boolean) => void): void => {
    ipcRenderer.on("hover-change", (_event, isOver: boolean) =>
      callback(isOver)
    );
  },

  // ── Bridge: Figma client list ────────────────────────────────────────────
  /**
   * Called by the main process whenever the list of connected Figma clients changes.
   * Provides the full updated list on every call.
   */
  onBridgeClients: (callback: (clients: ClientInfo[]) => void): void => {
    ipcRenderer.on("bridge-clients", (_event, clients: ClientInfo[]) =>
      callback(clients)
    );
  },

  // ── Bridge: messages from Figma ─────────────────────────────────────────
  /**
   * Called when a Figma client sends a message (e.g. SELECTION_CHANGED, PONG, ANALYSIS_RESULT).
   */
  onBridgeMessage: (
    callback: (clientId: string, msg: FigmaMessage) => void
  ): void => {
    ipcRenderer.on(
      "bridge-message",
      (_event, clientId: string, msg: FigmaMessage) => callback(clientId, msg)
    );
  },

  // ── Bridge: send to Figma ────────────────────────────────────────────────
  /** Send a message to a specific Figma client by its clientId. */
  bridgeSend: (clientId: string, msg: unknown): void => {
    ipcRenderer.send("bridge-send", clientId, msg);
  },

  /** Broadcast a message to all connected Figma clients. */
  bridgeBroadcast: (msg: unknown): void => {
    ipcRenderer.send("bridge-broadcast", msg);
  },
});
