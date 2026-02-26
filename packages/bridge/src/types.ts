// ── Shared type definitions for @guardian/bridge ─────────────────────────────
// Used by BridgeServer (Electron) and mirrored in the BridgeClient inline script
// embedded in figma-plugin/ui.html.

export type ClientType = 'plugin' | 'widget';

export interface ClientInfo {
  id: string;
  clientType: ClientType;
  /** Figma widget node ID — only for clientType 'widget' */
  widgetId?: string;
  /** Figma file key — may be undefined until the plugin loads the file context */
  fileKey?: string;
  connectedAt: number;
}

// ── Messages: Figma → Electron ────────────────────────────────────────────────

export interface RegisterMessage {
  type: 'REGISTER';
  clientType: ClientType;
  widgetId?: string;
  fileKey?: string;
}

export interface SelectionChangedMessage {
  type: 'SELECTION_CHANGED';
  nodes: Array<{ id: string; name: string; type: string; bounds?: unknown }>;
  fileKey?: string;
}

export interface AnalysisResultMessage {
  type: 'ANALYSIS_RESULT';
  issues: Array<{ nodeId: string; severity: 'error' | 'warning' | 'info'; message: string }>;
  fileKey?: string;
}

export interface PongMessage {
  type: 'PONG';
}

/** Figma plugin UI → BridgeServer (Electron) */
export type FigmaMessage =
  | RegisterMessage
  | SelectionChangedMessage
  | AnalysisResultMessage
  | PongMessage;

// ── Messages: Electron → Figma ────────────────────────────────────────────────

export interface PingMessage {
  type: 'PING';
}

export interface TriggerAnalysisMessage {
  type: 'TRIGGER_ANALYSIS';
}

/**
 * Ask the Figma plugin to execute arbitrary JS in the Figma main thread.
 * Leverages the existing EXECUTE_CODE handler in figma-plugin/code.ts.
 * Use this to create frames, components, change properties, etc.
 *
 * @example
 *   bridgeServer.broadcast({ type: 'EXECUTE_CODE', id: 'create-1',
 *     code: "const f = figma.createFrame(); f.name = 'Guardian Frame';" })
 */
export interface ExecuteCodeMessage {
  type: 'EXECUTE_CODE';
  code: string;
  id?: string;
}

export interface HighlightNodeMessage {
  type: 'HIGHLIGHT_NODE';
  nodeId: string;
}

export interface NotifyMessage {
  type: 'NOTIFY';
  message: string;
}

/** BridgeServer (Electron) → Figma plugin UI */
export type ElectronMessage =
  | PingMessage
  | TriggerAnalysisMessage
  | ExecuteCodeMessage
  | HighlightNodeMessage
  | NotifyMessage;
