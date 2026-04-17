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
  AgentActivity,
  TokenUsage,
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
  | { type: "orchestrator_brief"; content: string }
  | { type: "orchestrator_text"; content: string; modelId?: string; usage?: TokenUsage; intercepted?: { action: string; reason: string; originalModel?: string } }
  | { type: "orchestrator_reasoning"; content: string; modelId?: string; simulated?: boolean; usage?: TokenUsage; intercepted?: { action: string; reason: string; originalModel?: string } }
  | { type: "orchestrator_tool_call"; toolName: string; args: Record<string, unknown> }
  | { type: "orchestrator_tool_result"; toolName: string; result: string; isError: boolean }
  | { type: "orchestrator_directive"; agentShortId: string; content: string }
  | { type: "peer_message"; fromAgentId: string; toAgentId: string; content: string }
  | { type: "broadcast_message"; fromAgentId: string; content: string }
  | { type: "sub_conv_opened"; subConvId: string; participantIds: string[]; topic: string }
  | { type: "sub_conv_message"; subConvId: string; fromAgentId: string; content: string }
  | { type: "sub_conv_closed"; subConvId: string; reason: string }
  | { type: "user_input_received"; content: string; targetAgentId?: string }
  | { type: "timer_tick"; remainingMs: number; totalMs: number }
  | { type: "guardrail_blocked"; agentShortId: string; blockedAction: string; reason: string }
  | { type: "agent_activity"; agentShortId: string; activities: AgentActivity[] }
  | { type: "orchestrator_input"; content: string; fromAgentShortId?: string }
  | { type: "guardian_feedback"; content: string; targetRole: "orchestrator" | "agent"; targetAgentShortId?: string }
  | { type: "system_prompt"; content: string; targetRole: "orchestrator" | "agent"; targetAgentShortId?: string }
  | { type: "orchestration_completed"; status: "completed" | "completed_with_errors" | "failed" | "cancelled" | "timed_out"; error?: string }
  | { type: "error"; message: string }
  // ---------------------------------------------------------------------------
  // Streaming events (used by both chat and collab workflows)
  // ---------------------------------------------------------------------------
  | { type: "text_delta"; content: string; requestId: string }
  | { type: "reasoning_delta"; content: string; requestId: string; simulated?: boolean }
  | { type: "text_complete"; content: string; requestId: string; modelId?: string; usage?: TokenUsage; reasoning?: string }
  | { type: "tool_call_start"; toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { type: "tool_call_result"; toolName: string; toolCallId: string; result: string; isError: boolean }
  | { type: "figma_execute_ack"; requestId: string; status: "received" | "awaiting_approval"; pluginClientId: string };

// ---------------------------------------------------------------------------
// Query response (Temporal query handler)
// ---------------------------------------------------------------------------

export type OrchestrationStatusResponse = {
  orchestrationId: string;
  status: "active" | "completed" | "completed_with_errors" | "failed" | "cancelled" | "timed_out";
  agents: AgentViewState[];
  /** Events since the requested cursor */
  events: OrchestrationSSEEvent[];
  /** Cursor position (= total event count). Pass this as sinceIndex on next query. */
  eventCursor: number;
  /** Timer remaining in ms */
  timerRemainingMs: number | null;
  /** Total orchestration duration in ms */
  totalDurationMs: number;
};
