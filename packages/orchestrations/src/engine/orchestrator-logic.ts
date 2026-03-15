/**
 * Orchestrator coordination logic — engine-agnostic.
 *
 * This module contains the pure business logic for the orchestrator workflow.
 * It operates on state objects and returns actions/effects that the engine
 * adapter (Temporal, Inngest, etc.) translates into actual calls.
 */

import type {
  AgentId,
  AgentReportPayload,
  UserInputPayload,
  SubConvNotifyPayload,
  BroadcastPayload,
  DirectivePayload,
  AgentDirectoryPayload,
  GuardrailBlockedPayload,
  AgentActivityPayload,
} from "../types/signals.js";
import type { AgentViewState, OrchestrationSSEEvent } from "../types/events.js";
import type { AgentState, StartOrchestrationParams, LLMMessage, OrchestrationResult } from "../types/agents.js";
import { parseDirectives, parseAgentDoneMarkers } from "../logic/directive-parser.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_DURATION_MS = 10 * 60_000; // 10 minutes
export const IDLE_NUDGE_MS = 30_000; // 30s before nudging
export const GRACE_PERIOD_MS = 5_000; // 5s grace after all agents done

// ---------------------------------------------------------------------------
// Orchestrator state
// ---------------------------------------------------------------------------

export type OrchestratorState = {
  orchestrationId: string;
  userId: string;
  task: string;
  status: "active" | "completed" | "cancelled" | "timed_out";
  agents: Map<string, AgentState>;
  /** LLM conversation history for the orchestrator */
  messageHistory: LLMMessage[];
  /** Queued reports from agents */
  pendingReports: AgentReportPayload[];
  /** Queued user input */
  userInputQueue: UserInputPayload[];
  /** Sub-conversation notifications (info only) */
  subConvNotifications: SubConvNotifyPayload[];
  /** Queued guardrail blocked notifications */
  pendingGuardrails: GuardrailBlockedPayload[];
  /** Queued agent activity notifications */
  pendingActivities: AgentActivityPayload[];
  /** Events to be drained by the SSE consumer */
  eventLog: OrchestrationSSEEvent[];
  /** Orchestration start time */
  startedAt: number;
  /** Max duration in ms */
  maxDurationMs: number;
  /** Context data */
  context?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Effects — actions the engine adapter must execute
// ---------------------------------------------------------------------------

export type OrchestratorEffect =
  | { type: "start_agent"; agent: AgentId; task: string; context?: Record<string, unknown> }
  | { type: "send_directory"; agentWorkflowId: string; directory: AgentDirectoryPayload }
  | { type: "send_directive"; agentWorkflowId: string; directive: DirectivePayload }
  | { type: "call_llm"; messages: LLMMessage[] }
  | { type: "broadcast_to_agents"; excludeShortIds: string[]; content: string; fromAgentId: string }
  | { type: "save_state"; state: OrchestratorState }
  | { type: "cancel_agent"; agentWorkflowId: string }
  | { type: "complete"; result: OrchestrationResult }
  | { type: "emit_event"; event: OrchestrationSSEEvent };

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function createOrchestratorState(params: StartOrchestrationParams): OrchestratorState {
  const agents = new Map<string, AgentState>();
  for (const agent of params.targetAgents) {
    agents.set(agent.shortId, { agent, status: "pending", confirmedByAgent: false });
  }

  return {
    orchestrationId: `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: params.userId,
    task: params.task,
    status: "active",
    agents,
    messageHistory: [],
    pendingReports: [],
    userInputQueue: [],
    subConvNotifications: [],
    pendingGuardrails: [],
    pendingActivities: [],
    eventLog: [],
    startedAt: Date.now(),
    maxDurationMs: params.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
    context: params.context,
  };
}

// ---------------------------------------------------------------------------
// Phase 1: Generate effects to start all agents
// ---------------------------------------------------------------------------

export function generateStartEffects(state: OrchestratorState): OrchestratorEffect[] {
  const effects: OrchestratorEffect[] = [];

  for (const [, agentState] of state.agents) {
    effects.push({
      type: "start_agent",
      agent: agentState.agent,
      task: state.task,
      context: state.context,
    });
  }

  return effects;
}

// ---------------------------------------------------------------------------
// Phase 2: After agents are started, generate directory effects
// ---------------------------------------------------------------------------

export function generateDirectoryEffects(state: OrchestratorState, orchestratorWorkflowId: string): OrchestratorEffect[] {
  const directory: AgentDirectoryPayload = {
    agents: {},
    orchestratorWorkflowId,
  };

  for (const [shortId, agentState] of state.agents) {
    directory.agents[shortId] = agentState.agent;
  }

  const effects: OrchestratorEffect[] = [];
  for (const [, agentState] of state.agents) {
    if (agentState.agent.workflowId) {
      effects.push({
        type: "send_directory",
        agentWorkflowId: agentState.agent.workflowId,
        directory,
      });
    }
  }

  return effects;
}

// ---------------------------------------------------------------------------
// Phase 3: Generate planning LLM call
// ---------------------------------------------------------------------------

export function generatePlanningCall(state: OrchestratorState): OrchestratorEffect {
  const agentList = Array.from(state.agents.values())
    .map((a) => `- #${a.agent.shortId} (${a.agent.label}${a.agent.fileName ? `, file: ${a.agent.fileName}` : ""})`)
    .join("\n");

  const planningMessage: LLMMessage = {
    role: "user",
    content: `You are the orchestrator of a multi-agent collaboration. Your task:\n\n${state.task}\n\nAvailable agents:\n${agentList}\n\nPlan the work and assign directives to each agent. For each agent, write:\n[DIRECTIVE:#agentShortId]\nThe task for this agent...\n[/DIRECTIVE]\n\nBe specific about what each agent should do. Consider dependencies between tasks.`,
  };

  state.messageHistory.push(planningMessage);

  return {
    type: "call_llm",
    messages: [...state.messageHistory],
  };
}

// ---------------------------------------------------------------------------
// Phase 3b: Process LLM planning response
// ---------------------------------------------------------------------------

export function processPlanningResponse(
  state: OrchestratorState,
  llmResponse: string
): OrchestratorEffect[] {
  state.messageHistory.push({ role: "assistant", content: llmResponse });

  const directives = parseDirectives(llmResponse);
  const effects: OrchestratorEffect[] = [];

  effects.push({
    type: "emit_event",
    event: { type: "orchestrator_thinking", content: llmResponse },
  });
  state.eventLog.push({ type: "orchestrator_thinking", content: llmResponse });

  for (const directive of directives) {
    const agentState = state.agents.get(directive.agentShortId);
    if (!agentState?.agent.workflowId) continue;

    agentState.status = "active";

    const payload: DirectivePayload = {
      directiveId: `dir-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      content: directive.content,
      context: state.context,
      expectedResult: directive.expectedResult,
    };

    effects.push({
      type: "send_directive",
      agentWorkflowId: agentState.agent.workflowId,
      directive: payload,
    });

    effects.push({
      type: "emit_event",
      event: {
        type: "orchestrator_directive",
        agentShortId: directive.agentShortId,
        content: directive.content,
      },
    });
    state.eventLog.push({
      type: "orchestrator_directive",
      agentShortId: directive.agentShortId,
      content: directive.content,
    });
  }

  return effects;
}

// ---------------------------------------------------------------------------
// Phase 4: Process incoming reports
// ---------------------------------------------------------------------------

export function processReports(state: OrchestratorState): OrchestratorEffect[] {
  if (state.pendingReports.length === 0) return [];

  const effects: OrchestratorEffect[] = [];
  const reports = state.pendingReports.splice(0);

  for (const report of reports) {
    const agentState = state.agents.get(report.agentShortId);
    if (!agentState) continue;

    agentState.lastReport = {
      status: report.status,
      summary: report.summary,
      result: report.result,
      screenshot: report.screenshot,
      changes: report.changes,
      timestamp: new Date().toISOString(),
    };

    if (report.status === "completed" || report.status === "failed" || report.status === "interrupted") {
      agentState.status = report.status === "completed" ? "completed"
        : report.status === "interrupted" ? "interrupted" : "failed";
      agentState.confirmedByAgent = true;
    }

    // Inject report into LLM history
    const reportMsg = `[Agent report from #${report.agentShortId} — ${report.status}]${report.summary ? `\n${report.summary}` : ""}`;
    state.messageHistory.push({ role: "user", content: reportMsg });

    // Emit orchestrator_input so the UI shows what Guardian sent to the orchestrator LLM
    effects.push({
      type: "emit_event",
      event: {
        type: "orchestrator_input",
        content: reportMsg,
        fromAgentShortId: report.agentShortId,
      },
    });
    state.eventLog.push({
      type: "orchestrator_input",
      content: reportMsg,
      fromAgentShortId: report.agentShortId,
    });

    effects.push({
      type: "emit_event",
      event: {
        type: "agent_report",
        agentShortId: report.agentShortId,
        report: agentState.lastReport,
      },
    });
    state.eventLog.push({
      type: "agent_report",
      agentShortId: report.agentShortId,
      report: agentState.lastReport,
    });

    effects.push({
      type: "emit_event",
      event: {
        type: "agent_status_changed",
        agentShortId: report.agentShortId,
        status: agentState.status,
      },
    });
    state.eventLog.push({
      type: "agent_status_changed",
      agentShortId: report.agentShortId,
      status: agentState.status,
    });
  }

  // Ask LLM to evaluate reports
  effects.push({
    type: "call_llm",
    messages: [...state.messageHistory],
  });

  return effects;
}

// ---------------------------------------------------------------------------
// Phase 4b: Process LLM coordination response (after reports)
// ---------------------------------------------------------------------------

export function processCoordinationResponse(
  state: OrchestratorState,
  llmResponse: string
): OrchestratorEffect[] {
  state.messageHistory.push({ role: "assistant", content: llmResponse });

  const effects: OrchestratorEffect[] = [];

  // Parse [AGENT_DONE:#shortId] markers
  const doneMarkers = parseAgentDoneMarkers(llmResponse);
  for (const shortId of doneMarkers) {
    const agentState = state.agents.get(shortId);
    if (agentState && agentState.status !== "completed") {
      agentState.status = "completed";
      effects.push({
        type: "emit_event",
        event: { type: "agent_status_changed", agentShortId: shortId, status: "completed" },
      });
      state.eventLog.push({
        type: "agent_status_changed",
        agentShortId: shortId,
        status: "completed",
      });
    }
  }

  // Relay coordination response to active agents
  const activeAgents = Array.from(state.agents.values()).filter(
    (a) => a.status === "active"
  );
  if (activeAgents.length > 0) {
    effects.push({
      type: "broadcast_to_agents",
      excludeShortIds: doneMarkers,
      content: llmResponse,
      fromAgentId: "orchestrator",
    });
  }

  effects.push({
    type: "emit_event",
    event: { type: "orchestrator_thinking", content: llmResponse },
  });
  state.eventLog.push({ type: "orchestrator_thinking", content: llmResponse });

  return effects;
}

// ---------------------------------------------------------------------------
// Process user input
// ---------------------------------------------------------------------------

export function processUserInput(state: OrchestratorState): OrchestratorEffect[] {
  if (state.userInputQueue.length === 0) return [];

  const effects: OrchestratorEffect[] = [];
  const inputs = state.userInputQueue.splice(0);

  for (const input of inputs) {
    effects.push({
      type: "emit_event",
      event: { type: "user_input_received", content: input.content, targetAgentId: input.targetAgentId },
    });
    state.eventLog.push({
      type: "user_input_received",
      content: input.content,
      targetAgentId: input.targetAgentId,
    });

    // Inject into orchestrator LLM
    const prefix = input.targetAgentId
      ? `[User input for #${input.targetAgentId}]`
      : "[User input]";
    state.messageHistory.push({
      role: "user",
      content: `${prefix} ${input.content}`,
    });
  }

  // Let LLM process user input
  effects.push({
    type: "call_llm",
    messages: [...state.messageHistory],
  });

  return effects;
}

// ---------------------------------------------------------------------------
// Check completion
// ---------------------------------------------------------------------------

export function checkCompletion(state: OrchestratorState): OrchestratorEffect | null {
  // Time check
  const elapsed = Date.now() - state.startedAt;
  if (elapsed >= state.maxDurationMs) {
    state.status = "timed_out";
    return {
      type: "complete",
      result: buildResult(state),
    };
  }

  // All agents done check — require agent self-confirmation, not just orchestrator marking.
  // The orchestrator LLM may emit [AGENT_DONE] before the agent has actually reported.
  const allDone = Array.from(state.agents.values()).every(
    (a) => a.confirmedByAgent && (a.status === "completed" || a.status === "failed" || a.status === "interrupted")
  );

  if (allDone) {
    state.status = "completed";
    return {
      type: "complete",
      result: buildResult(state),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Handle cancellation
// ---------------------------------------------------------------------------

export function handleCancellation(state: OrchestratorState): OrchestratorEffect[] {
  state.status = "cancelled";

  const effects: OrchestratorEffect[] = [];
  for (const [, agentState] of state.agents) {
    if (agentState.agent.workflowId && agentState.status === "active") {
      effects.push({ type: "cancel_agent", agentWorkflowId: agentState.agent.workflowId });
    }
  }

  effects.push({
    type: "complete",
    result: buildResult(state),
  });

  return effects;
}

// ---------------------------------------------------------------------------
// Handle broadcast relay
// ---------------------------------------------------------------------------

export function handleBroadcastRelay(
  state: OrchestratorState,
  broadcast: BroadcastPayload
): OrchestratorEffect[] {
  const effects: OrchestratorEffect[] = [];

  effects.push({
    type: "broadcast_to_agents",
    excludeShortIds: [broadcast.fromAgentId],
    content: broadcast.content,
    fromAgentId: broadcast.fromAgentId,
  });

  effects.push({
    type: "emit_event",
    event: {
      type: "broadcast_message",
      fromAgentId: broadcast.fromAgentId,
      content: broadcast.content,
    },
  });
  state.eventLog.push({
    type: "broadcast_message",
    fromAgentId: broadcast.fromAgentId,
    content: broadcast.content,
  });

  return effects;
}

// ---------------------------------------------------------------------------
// Process guardrail blocked notifications
// ---------------------------------------------------------------------------

export function processGuardrailBlocked(state: OrchestratorState): OrchestratorEffect[] {
  if (state.pendingGuardrails.length === 0) return [];

  const effects: OrchestratorEffect[] = [];
  const guardrails = state.pendingGuardrails.splice(0);

  for (const g of guardrails) {
    const event: OrchestrationSSEEvent = {
      type: "guardrail_blocked",
      agentShortId: g.agentShortId,
      blockedAction: g.blockedAction,
      reason: g.reason,
    };
    effects.push({ type: "emit_event", event });
    state.eventLog.push(event);
  }

  return effects;
}

// ---------------------------------------------------------------------------
// Process agent activity notifications (passthrough to SSE)
// ---------------------------------------------------------------------------

export function processAgentActivities(state: OrchestratorState): OrchestratorEffect[] {
  if (state.pendingActivities.length === 0) return [];

  const effects: OrchestratorEffect[] = [];
  const activities = state.pendingActivities.splice(0);

  for (const a of activities) {
    const event: OrchestrationSSEEvent = {
      type: "agent_activity",
      agentShortId: a.agentShortId,
      activities: a.activities,
    };
    effects.push({ type: "emit_event", event });
    state.eventLog.push(event);
  }

  return effects;
}

// ---------------------------------------------------------------------------
// Get agent view states (for SSE query)
// ---------------------------------------------------------------------------

export function getAgentViewStates(state: OrchestratorState): AgentViewState[] {
  return Array.from(state.agents.values()).map((a) => ({
    shortId: a.agent.shortId,
    label: a.agent.label,
    type: a.agent.type,
    fileName: a.agent.fileName,
    status: a.status,
    lastReport: a.lastReport
      ? {
          status: a.lastReport.status,
          summary: a.lastReport.summary,
          changes: a.lastReport.changes,
          timestamp: a.lastReport.timestamp,
        }
      : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Get events since cursor (for SSE polling — non-destructive)
// ---------------------------------------------------------------------------

export function getEventsSince(state: OrchestratorState, sinceIndex = 0): { events: OrchestrationSSEEvent[]; cursor: number } {
  return {
    events: state.eventLog.slice(sinceIndex),
    cursor: state.eventLog.length,
  };
}

/** @deprecated Use getEventsSince instead — drainEvents clears events and breaks multi-client SSE. */
export function drainEvents(state: OrchestratorState): OrchestrationSSEEvent[] {
  const events = [...state.eventLog];
  state.eventLog = [];
  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResult(state: OrchestratorState): OrchestrationResult {
  const agentResults: OrchestrationResult["agentResults"] = {};
  for (const [shortId, agentState] of state.agents) {
    // Prefer agentState.status when the orchestrator marked the agent done
    // via [AGENT_DONE] marker before the agent's own report arrived.
    const resolvedStatus =
      agentState.status === "completed"
        ? "completed"
        : (agentState.lastReport?.status ?? "interrupted");
    agentResults[shortId] = {
      status: resolvedStatus,
      summary: agentState.lastReport?.summary,
      changes: agentState.lastReport?.changes,
    };
  }

  return {
    status: state.status === "active" ? "completed" : state.status,
    agentResults,
    durationMs: Date.now() - state.startedAt,
  };
}
