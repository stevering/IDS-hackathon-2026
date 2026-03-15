/**
 * Signal payload types for Temporal workflow communication.
 *
 * These replace the Supabase RT broadcast events. Each signal type
 * maps to a Temporal signal that flows between workflows.
 */

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

export type AgentId = {
  /** Human-readable short ID (e.g. "#figma-1") */
  shortId: string;
  /** Temporal workflow ID for this agent */
  workflowId: string;
  /** Label shown in the UI (e.g. "Button Component - main.fig") */
  label: string;
  /** Agent type */
  type: "figma-plugin" | "web" | "cloud";
  /** Figma file name if applicable */
  fileName?: string;
  /** Figma client ID for plugin transport */
  pluginClientId?: string;
};

// ---------------------------------------------------------------------------
// Directory (orchestrator → agents at startup)
// ---------------------------------------------------------------------------

export type AgentDirectoryPayload = {
  /** Map of shortId → AgentId for all agents in this orchestration */
  agents: Record<string, AgentId>;
  /** The orchestrator's workflow ID (for signals back to the orchestrator) */
  orchestratorWorkflowId: string;
};

// ---------------------------------------------------------------------------
// Orchestrator → Agent signals
// ---------------------------------------------------------------------------

export type DirectivePayload = {
  /** Unique ID for this directive */
  directiveId: string;
  /** The task/instruction content */
  content: string;
  /** Optional context (screenshots, file references, etc.) */
  context?: Record<string, unknown>;
  /** Expected result description */
  expectedResult?: string;
  /** Whether the agent should take a screenshot when done */
  wantScreenshot?: boolean;
};

// ---------------------------------------------------------------------------
// Agent → Orchestrator signals
// ---------------------------------------------------------------------------

export type AgentReportStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "needs_input"
  | "interrupted";

export type AgentReportPayload = {
  /** Which agent is reporting */
  agentShortId: string;
  /** Current status */
  status: AgentReportStatus;
  /** Summary of work done */
  summary?: string;
  /** Structured result data */
  result?: Record<string, unknown>;
  /** Base64 screenshot if requested */
  screenshot?: string;
  /** List of changes made */
  changes?: AgentChange[];
};

export type AgentChange = {
  type: "create" | "update" | "delete" | "style" | "layout" | "other";
  description: string;
  nodeId?: string;
  nodeName?: string;
};

// ---------------------------------------------------------------------------
// Agent → Agent peer-to-peer signals
// ---------------------------------------------------------------------------

export type PeerMessagePayload = {
  /** Sender's short ID */
  fromAgentId: string;
  /** Message content */
  content: string;
  /** Optional mentions */
  mentions?: string[];
};

// ---------------------------------------------------------------------------
// Broadcast signals
// ---------------------------------------------------------------------------

export type BroadcastPayload = {
  /** Sender's short ID */
  fromAgentId: string;
  /** Message content */
  content: string;
};

// ---------------------------------------------------------------------------
// Sub-conversation signals
// ---------------------------------------------------------------------------

export type SubConvInvitePayload = {
  /** Unique sub-conversation ID */
  subConvId: string;
  /** Initiator's short ID */
  initiatorId: string;
  /** All invited participant short IDs */
  participantIds: string[];
  /** Topic of the sub-conversation */
  topic: string;
  /** Max duration in ms (default 120_000) */
  durationMs: number;
};

export type SubConvMessagePayload = {
  /** Sub-conversation ID */
  subConvId: string;
  /** Sender's short ID */
  fromAgentId: string;
  /** Message content */
  content: string;
};

export type SubConvClosePayload = {
  /** Sub-conversation ID */
  subConvId: string;
  /** Reason for closing */
  reason: "completed" | "timeout" | "cancelled";
};

export type SubConvResponsePayload = {
  /** Sub-conversation ID */
  subConvId: string;
  /** Responder's short ID */
  agentId: string;
  /** Whether the invite was accepted */
  accepted: boolean;
};

/** Notification sent to orchestrator about sub-conversation lifecycle */
export type SubConvNotifyPayload = {
  /** Sub-conversation ID */
  subConvId: string;
  /** Lifecycle event */
  event: "opened" | "closed";
  /** Participants involved */
  participantIds: string[];
  /** Topic */
  topic?: string;
  /** Reason (only for closed) */
  reason?: "completed" | "timeout" | "cancelled";
};

// ---------------------------------------------------------------------------
// Agent → Orchestrator guardrail notifications
// ---------------------------------------------------------------------------

export type GuardrailBlockedPayload = {
  /** Which agent triggered the guardrail */
  agentShortId: string;
  /** What was blocked (e.g. "figma.closePlugin()") */
  blockedAction: string;
  /** Human-readable reason */
  reason: string;
};

// ---------------------------------------------------------------------------
// Agent activity (internal visibility)
// ---------------------------------------------------------------------------

export type AgentActivity =
  | { action: "thinking"; content: string }
  | { action: "tool_call"; toolName: string; summary: string }
  | { action: "code_review_rejected"; issues: string[]; feedback?: string }
  | { action: "code_review_passed"; codeSnippet: string }
  | { action: "code_executed"; success: boolean; summary: string }
  | { action: "guardian_message"; recipient: string; message: string };

export type AgentActivityPayload = {
  /** Which agent is reporting activity */
  agentShortId: string;
  /** Batched activities from one LLM step */
  activities: AgentActivity[];
};

// ---------------------------------------------------------------------------
// User input (browser → workflow)
// ---------------------------------------------------------------------------

export type UserInputPayload = {
  /** Message content from the user */
  content: string;
  /** Target agent short ID (if directed at a specific agent) */
  targetAgentId?: string;
};

// ---------------------------------------------------------------------------
// Plugin disconnect
// ---------------------------------------------------------------------------

export type PluginDisconnectedPayload = {
  /** The plugin client ID that went offline */
  pluginClientId: string;
  /** Which agent was using this plugin */
  agentShortId: string;
};

// ---------------------------------------------------------------------------
// Agent readiness
// ---------------------------------------------------------------------------

export type AgentReadyPayload = {
  /** Agent's short ID */
  agentShortId: string;
};

export type AgentDeclinedPayload = {
  /** Agent's short ID */
  agentShortId: string;
  /** Reason for declining */
  reason?: string;
};
