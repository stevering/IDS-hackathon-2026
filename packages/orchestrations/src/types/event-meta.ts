/**
 * Event metadata for orchestration UI.
 *
 * Provides typed categorization, direction, and visibility info
 * for every event type. Computed at display time — not transmitted in SSE.
 */

import type { OrchestrationSSEEvent, AgentViewState } from "./events.js";
import type { AgentActivity } from "./signals.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventCategory =
  | "lifecycle"
  | "message"
  | "thinking"
  | "llm-tool-call"
  | "llm-tool-result"
  | "system-tool-call"
  | "system-tool-result";

export type EventDirection =
  | "internal"
  | "guardian-to-orchestrator"
  | "guardian-to-agent"
  | "orchestrator-to-guardian"
  | "orchestrator-to-all"
  | "agent-to-guardian"
  | "guardian-to-figma"
  | "figma-to-guardian"
  | "user-to-orchestrator"
  | "agent-to-agent"
  | "broadcast";

export const DIRECTION_LABELS: Record<EventDirection, string> = {
  "internal": "internal",
  "guardian-to-orchestrator": "Guardian → Orchestrator",
  "guardian-to-agent": "Guardian → Agent",
  "orchestrator-to-guardian": "Orchestrator → Guardian",
  "orchestrator-to-all": "Orchestrator → All",
  "agent-to-guardian": "Agent → Guardian",
  "guardian-to-figma": "Guardian → Figma",
  "figma-to-guardian": "Figma → Guardian",
  "user-to-orchestrator": "User → Orchestrator",
  "agent-to-agent": "Agent → Agent",
  "broadcast": "broadcast",
};

export type EventMeta = {
  category: EventCategory;
  direction: EventDirection;
  subject: string;
  /** Whether this event is visible in normal mode (false = dev only) */
  visibleInNormalMode: boolean;
};

// ---------------------------------------------------------------------------
// Top-level event metadata
// ---------------------------------------------------------------------------

export function getEventMeta(event: OrchestrationSSEEvent): EventMeta {
  switch (event.type) {
    case "orchestration_started":
      return { category: "lifecycle", direction: "internal", subject: "orchestration launched", visibleInNormalMode: true };

    case "orchestrator_brief":
      return { category: "message", direction: "guardian-to-orchestrator", subject: "task briefing", visibleInNormalMode: false };

    case "orchestrator_text":
      return { category: "message", direction: "orchestrator-to-all", subject: "orchestrator response", visibleInNormalMode: true };

    case "orchestrator_reasoning":
      return { category: "thinking", direction: "internal", subject: "orchestrator reasoning", visibleInNormalMode: false };

    case "orchestrator_tool_call":
      return { category: "llm-tool-call", direction: "orchestrator-to-guardian", subject: "tool invocation", visibleInNormalMode: false };

    case "orchestrator_tool_result":
      return { category: "llm-tool-result", direction: "guardian-to-orchestrator", subject: "tool result", visibleInNormalMode: false };

    case "orchestrator_directive":
      return { category: "llm-tool-result", direction: "guardian-to-agent", subject: "directive delivery", visibleInNormalMode: true };

    case "orchestrator_input":
      return { category: "message", direction: "guardian-to-orchestrator", subject: "agent report forwarded", visibleInNormalMode: false };

    case "agent_status_changed":
      return { category: "lifecycle", direction: "internal", subject: "agent state change", visibleInNormalMode: true };

    case "agent_report":
      return { category: "message", direction: "agent-to-guardian", subject: "task report", visibleInNormalMode: true };

    case "guardrail_blocked":
      return { category: "lifecycle", direction: "internal", subject: "action blocked", visibleInNormalMode: true };

    case "user_input_received":
      return { category: "message", direction: "user-to-orchestrator", subject: "user instruction", visibleInNormalMode: true };

    case "peer_message":
      return { category: "message", direction: "agent-to-agent", subject: "peer communication", visibleInNormalMode: true };

    case "broadcast_message":
      return { category: "message", direction: "broadcast", subject: "broadcast", visibleInNormalMode: true };

    case "sub_conv_opened":
      return { category: "lifecycle", direction: "internal", subject: "sub-conv opened", visibleInNormalMode: true };

    case "sub_conv_message":
      return { category: "message", direction: "agent-to-agent", subject: "sub-conv message", visibleInNormalMode: true };

    case "sub_conv_closed":
      return { category: "lifecycle", direction: "internal", subject: "sub-conv closed", visibleInNormalMode: true };

    case "orchestration_completed":
      return { category: "lifecycle", direction: "internal", subject: "orchestration finished", visibleInNormalMode: true };

    case "error":
      return { category: "lifecycle", direction: "internal", subject: "error", visibleInNormalMode: true };

    case "system_prompt": {
      const spTarget = (event as { targetRole?: string }).targetRole;
      return {
        category: "lifecycle",
        direction: spTarget === "agent" ? "guardian-to-agent" : "guardian-to-orchestrator",
        subject: "system prompt",
        visibleInNormalMode: false,
      };
    }

    case "guardian_feedback": {
      const target = (event as { targetRole?: string }).targetRole;
      return {
        category: "message",
        direction: target === "agent" ? "guardian-to-agent" : "guardian-to-orchestrator",
        subject: "guardian feedback",
        visibleInNormalMode: true,
      };
    }

    case "agent_activity":
      return { category: "lifecycle", direction: "internal", subject: "agent activity", visibleInNormalMode: false };

    case "timer_tick":
      return { category: "lifecycle", direction: "internal", subject: "timer", visibleInNormalMode: false };

    default:
      return { category: "lifecycle", direction: "internal", subject: "unknown", visibleInNormalMode: false };
  }
}

// ---------------------------------------------------------------------------
// Agent activity sub-type metadata
// ---------------------------------------------------------------------------

export function getActivityMeta(activity: AgentActivity): EventMeta {
  switch (activity.action) {
    case "reasoning":
      return { category: "thinking", direction: "internal", subject: "agent reasoning", visibleInNormalMode: false };

    case "assistant_text":
      return { category: "message", direction: "internal", subject: "agent response", visibleInNormalMode: false };

    case "tool_call":
      return { category: "llm-tool-call", direction: "agent-to-guardian", subject: "tool invocation", visibleInNormalMode: false };

    case "code_review_passed":
      return { category: "system-tool-result", direction: "guardian-to-agent", subject: "linter OK", visibleInNormalMode: false };

    case "code_review_rejected":
      return { category: "system-tool-result", direction: "guardian-to-agent", subject: "linter rejected", visibleInNormalMode: false };

    case "code_review_llm_approved":
      return { category: "system-tool-result", direction: "guardian-to-agent", subject: "review approved", visibleInNormalMode: false };

    case "code_review_llm_rejected":
      return { category: "system-tool-result", direction: "guardian-to-agent", subject: "review rejected", visibleInNormalMode: false };

    case "code_executed":
      return { category: "system-tool-result", direction: "figma-to-guardian", subject: "execution result", visibleInNormalMode: false };

    case "code_verified":
      return { category: "system-tool-result", direction: "figma-to-guardian", subject: "verification", visibleInNormalMode: false };

    case "file_review_llm_response":
      return { category: "system-tool-result", direction: "guardian-to-agent", subject: "file review", visibleInNormalMode: false };

    case "guardian_message":
      return { category: "message", direction: "guardian-to-agent", subject: "tool result injected", visibleInNormalMode: false };

    case "code_review_llm_response":
      return { category: "system-tool-result", direction: "guardian-to-agent", subject: "review raw response", visibleInNormalMode: false };

    default:
      return { category: "lifecycle", direction: "internal", subject: "unknown", visibleInNormalMode: false };
  }
}

// ---------------------------------------------------------------------------
// Direction formatting with client names
// ---------------------------------------------------------------------------

/**
 * Format the direction with actual client names.
 *
 * Normal mode:  "Guardian → #Figma-Desktop-vopope"
 * Dev mode:     "Guardian → #Figma-Desktop-vopope (kukftiz0)"
 */
export function formatDirection(
  meta: EventMeta,
  event: OrchestrationSSEEvent,
  agents: AgentViewState[],
  showClientId?: boolean
): string {
  if (meta.direction === "internal" || meta.direction === "broadcast") {
    return meta.direction;
  }

  // Use the label map as base, then resolve "agent" to actual shortId
  const label = DIRECTION_LABELS[meta.direction];

  // Extract the agentShortId from the event (if present)
  const agentShortId = extractAgentShortId(event);
  if (!agentShortId) return label;

  // Replace "Agent" with the actual agent shortId
  const agentLabel = showClientId
    ? `${agentShortId} (${agents.find((a) => a.shortId === agentShortId)?.type ?? ""})`
    : agentShortId;

  return label.replace("Agent", agentLabel);
}

function extractAgentShortId(event: OrchestrationSSEEvent): string | undefined {
  if ("agentShortId" in event) return (event as { agentShortId: string }).agentShortId;
  if ("fromAgentId" in event) return (event as { fromAgentId: string }).fromAgentId;
  if ("fromAgentShortId" in event) return (event as { fromAgentShortId: string }).fromAgentShortId;
  return undefined;
}

// ---------------------------------------------------------------------------
// Category display colors (for UI badges)
// ---------------------------------------------------------------------------

export const CATEGORY_COLORS: Record<EventCategory, string> = {
  lifecycle: "bg-white/5 text-white/40 border-white/10",
  message: "bg-blue-500/10 text-blue-400/60 border-blue-500/15",
  thinking: "bg-amber-500/10 text-amber-400/60 border-amber-500/15",
  "llm-tool-call": "bg-indigo-500/10 text-indigo-400/60 border-indigo-500/15",
  "llm-tool-result": "bg-violet-500/10 text-violet-400/60 border-violet-500/15",
  "system-tool-call": "bg-emerald-500/10 text-emerald-400/60 border-emerald-500/15",
  "system-tool-result": "bg-emerald-500/8 text-emerald-400/50 border-emerald-500/12",
};
