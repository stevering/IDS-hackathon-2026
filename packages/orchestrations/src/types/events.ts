/**
 * Orchestration events streamed to the browser via SSE.
 *
 * These are the UI-facing events that the frontend consumes
 * to render the orchestration viewer panel.
 */

import type {
  AgentReportStatus,
  AgentChange,
  AgentId,
} from "./signals.js";

// ---------------------------------------------------------------------------
// Agent state (for the viewer)
// ---------------------------------------------------------------------------

export type AgentViewState = {
  shortId: string;
  label: string;
  type: AgentId["type"];
  fileName?: string;
  status: "pending" | "active" | "completed" | "failed" | "interrupted";
  lastReport?: {
    status: AgentReportStatus;
    summary?: string;
    changes?: AgentChange[];
    timestamp: string;
  };
};

// ---------------------------------------------------------------------------
// SSE event types
// ---------------------------------------------------------------------------

export type OrchestrationSSEEvent =
  | { type: "orchestration_started"; orchestrationId: string; agents: AgentViewState[] }
  | { type: "agent_status_changed"; agentShortId: string; status: AgentViewState["status"] }
  | { type: "agent_report"; agentShortId: string; report: AgentViewState["lastReport"] }
  | { type: "orchestrator_thinking"; content: string }
  | { type: "orchestrator_directive"; agentShortId: string; content: string }
  | { type: "peer_message"; fromAgentId: string; toAgentId: string; content: string }
  | { type: "broadcast_message"; fromAgentId: string; content: string }
  | { type: "sub_conv_opened"; subConvId: string; participantIds: string[]; topic: string }
  | { type: "sub_conv_message"; subConvId: string; fromAgentId: string; content: string }
  | { type: "sub_conv_closed"; subConvId: string; reason: string }
  | { type: "user_input_received"; content: string; targetAgentId?: string }
  | { type: "timer_tick"; remainingMs: number; totalMs: number }
  | { type: "orchestration_completed"; status: "completed" | "cancelled" | "timed_out" }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Query response (Temporal query handler)
// ---------------------------------------------------------------------------

export type OrchestrationStatusResponse = {
  orchestrationId: string;
  status: "active" | "completed" | "cancelled" | "timed_out";
  agents: AgentViewState[];
  /** New events since last query (drained on read) */
  events: OrchestrationSSEEvent[];
  /** Timer remaining in ms */
  timerRemainingMs: number | null;
  /** Total orchestration duration in ms */
  totalDurationMs: number;
};
