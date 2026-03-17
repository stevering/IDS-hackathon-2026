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
  | "guardian → orchestrator"
  | "guardian → agent"
  | "orchestrator → guardian"
  | "agent → guardian"
  | "guardian → figma"
  | "figma → guardian"
  | "user → orchestrator"
  | "agent → agent"
  | "broadcast";

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
      return { category: "message", direction: "guardian → orchestrator", subject: "task briefing", visibleInNormalMode: false };

    case "orchestrator_thinking":
      return { category: "thinking", direction: "internal", subject: "orchestrator reasoning", visibleInNormalMode: true };

    case "orchestrator_tool_call":
      return { category: "llm-tool-call", direction: "orchestrator → guardian", subject: "tool invocation", visibleInNormalMode: false };

    case "orchestrator_tool_result":
      return { category: "llm-tool-result", direction: "guardian → orchestrator", subject: "tool result", visibleInNormalMode: false };

    case "orchestrator_directive":
      return { category: "llm-tool-result", direction: "guardian → agent", subject: "directive delivery", visibleInNormalMode: true };

    case "orchestrator_input":
      return { category: "message", direction: "guardian → orchestrator", subject: "agent report forwarded", visibleInNormalMode: false };

    case "agent_status_changed":
      return { category: "lifecycle", direction: "internal", subject: "agent state change", visibleInNormalMode: true };

    case "agent_report":
      return { category: "message", direction: "agent → guardian", subject: "task report", visibleInNormalMode: true };

    case "guardrail_blocked":
      return { category: "lifecycle", direction: "internal", subject: "action blocked", visibleInNormalMode: true };

    case "user_input_received":
      return { category: "message", direction: "user → orchestrator", subject: "user instruction", visibleInNormalMode: true };

    case "peer_message":
      return { category: "message", direction: "agent → agent", subject: "peer communication", visibleInNormalMode: true };

    case "broadcast_message":
      return { category: "message", direction: "broadcast", subject: "broadcast", visibleInNormalMode: true };

    case "sub_conv_opened":
      return { category: "lifecycle", direction: "internal", subject: "sub-conv opened", visibleInNormalMode: true };

    case "sub_conv_message":
      return { category: "message", direction: "agent → agent", subject: "sub-conv message", visibleInNormalMode: true };

    case "sub_conv_closed":
      return { category: "lifecycle", direction: "internal", subject: "sub-conv closed", visibleInNormalMode: true };

    case "orchestration_completed":
      return { category: "lifecycle", direction: "internal", subject: "orchestration finished", visibleInNormalMode: true };

    case "error":
      return { category: "lifecycle", direction: "internal", subject: "error", visibleInNormalMode: true };

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

    case "thinking":
      return { category: "thinking", direction: "internal", subject: "agent response", visibleInNormalMode: false };

    case "tool_call":
      return { category: "llm-tool-call", direction: "agent → guardian", subject: "tool invocation", visibleInNormalMode: false };

    case "code_review_passed":
      return { category: "system-tool-result", direction: "guardian → agent", subject: "linter OK", visibleInNormalMode: false };

    case "code_review_rejected":
      return { category: "system-tool-result", direction: "guardian → agent", subject: "linter rejected", visibleInNormalMode: false };

    case "code_review_llm_approved":
      return { category: "system-tool-result", direction: "guardian → agent", subject: "review approved", visibleInNormalMode: false };

    case "code_review_llm_rejected":
      return { category: "system-tool-result", direction: "guardian → agent", subject: "review rejected", visibleInNormalMode: false };

    case "code_executed":
      return { category: "system-tool-result", direction: "figma → guardian", subject: "execution result", visibleInNormalMode: false };

    case "code_verified":
      return { category: "system-tool-result", direction: "figma → guardian", subject: "verification", visibleInNormalMode: false };

    case "guardian_message":
      return { category: "message", direction: "guardian → agent", subject: "tool result injected", visibleInNormalMode: false };

    case "code_review_llm_response":
      return { category: "system-tool-result", direction: "guardian → agent", subject: "review raw response", visibleInNormalMode: false };

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

  // Extract the agentShortId from the event (if present)
  const agentShortId = extractAgentShortId(event);

  // Build parts
  const [from, to] = meta.direction.split(" → ");

  const resolveActor = (actor: string): string => {
    if (actor === "agent" && agentShortId) {
      const agent = agents.find((a) => a.shortId === agentShortId);
      const label = agentShortId;
      if (showClientId && agent) {
        return `${label} (${agent.type})`;
      }
      return label;
    }
    if (actor === "orchestrator") return "Orchestrator";
    if (actor === "guardian") return "Guardian";
    if (actor === "figma") return "Figma";
    if (actor === "user") return "User";
    return actor;
  };

  return `${resolveActor(from)} → ${resolveActor(to)}`;
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
