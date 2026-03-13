/**
 * Plugin transport abstraction.
 *
 * Isolates the "last-km" communication with the Figma plugin
 * behind an interface. Currently backed by Supabase Realtime,
 * but can be swapped for WebSocket, SSE, etc.
 */

import type { ExecuteCodeParams, ExecuteCodeResult, ConnectedClient } from "../types/agents.js";

// ---------------------------------------------------------------------------
// Disposable (for cleanup)
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Plugin transport interface
// ---------------------------------------------------------------------------

export interface IPluginTransport {
  /** Execute code on the Figma plugin and wait for the result */
  executeCode(params: ExecuteCodeParams): Promise<ExecuteCodeResult>;

  /** Get currently connected plugin clients for a user */
  getConnectedClients(userId: string): Promise<ConnectedClient[]>;

  /** Monitor presence changes (new connections / disconnections) */
  monitorPresence(
    userId: string,
    callback: (clients: ConnectedClient[]) => void
  ): Disposable;
}
