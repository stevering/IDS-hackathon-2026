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
import { buildOrchestratorSystemPrompt } from "../logic/system-prompts.js";
import type { LLMToolDefinition, LLMToolCall } from "../types/agents.js";
import { wrapMessage, agentSource, type MetadataFormat } from "../logic/message-metadata.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_DURATION_MS = 10 * 60_000; // 10 minutes
export const IDLE_NUDGE_MS = 30_000; // 30s before nudging
export const GRACE_PERIOD_MS = 5_000; // 5s grace after all agents done

// ---------------------------------------------------------------------------
// Context engineering — build optimized messages for orchestrator LLM calls (Phase 3.3-3.4)
// ---------------------------------------------------------------------------

/**
 * Build optimized message array for orchestrator LLM calls.
 *
 * Injects the persisted plan (if any) as a system message right after
 * the main system prompt. This ensures:
 * 1. The plan survives context truncation (re-injected each call)
 * 2. System prompt + plan form a stable prefix for KV cache hits (Phase 3.4)
 */
function buildOrchestratorMessages(state: OrchestratorState): LLMMessage[] {
  const messages = [...state.messageHistory];

  // Inject plan after system prompt (index 1) if present
  if (state.plan) {
    const planMessage: LLMMessage = {
      role: "system",
      content: `## Your current plan\n${state.plan}\n\nUpdate this plan as agents report progress. When an agent completes, note what was done and what remains.`,
    };
    // Insert after the first system prompt
    const systemIdx = messages.findIndex(m => m.role === "system");
    if (systemIdx >= 0) {
      messages.splice(systemIdx + 1, 0, planMessage);
    } else {
      messages.unshift(planMessage);
    }
  }

  return messages;
}

/**
 * Extract or update the orchestrator's plan from its LLM response.
 * The plan is the orchestrator's understanding of what each agent should do
 * and the current progress state.
 */
function updatePlanFromResponse(state: OrchestratorState, content: string, toolCalls?: LLMToolCall[]): void {
  if (!toolCalls?.length) return;

  // Build plan from the directives being sent
  const directives = toolCalls.filter(tc => tc.name === "send_agent_directive");
  const markDones = toolCalls.filter(tc => tc.name === "mark_agent_done");

  if (directives.length > 0 && !state.plan) {
    // First directives — create the initial plan
    const planParts: string[] = [];
    for (const d of directives) {
      const args = d.arguments as { agentShortId?: string; content?: string };
      planParts.push(`- ${args.agentShortId}: ${(args.content ?? "").slice(0, 150)}`);
    }
    state.plan = "Directives assigned:\n" + planParts.join("\n");
  } else if (markDones.length > 0 && state.plan) {
    // Agent marked done — update plan
    for (const md of markDones) {
      const args = md.arguments as { agentShortId?: string };
      if (args.agentShortId) {
        state.plan += `\n- ${args.agentShortId}: DONE`;
      }
    }
  }
}

/**
 * Update the plan with agent report information.
 */
function updatePlanFromReport(state: OrchestratorState, report: AgentReportPayload): void {
  if (!state.plan) return;
  const status = report.status === "directive_done" ? "directive completed" : report.status;
  state.plan += `\n- ${report.agentShortId} reported: ${status} — ${(report.summary ?? "").slice(0, 100)}`;
}

// ---------------------------------------------------------------------------
// Orchestrator state
// ---------------------------------------------------------------------------

export type OrchestratorState = {
  orchestrationId: string;
  userId: string;
  task: string;
  status: "active" | "completed" | "completed_with_errors" | "failed" | "cancelled" | "timed_out";
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
  /** Resolved model ID (set from params.model) */
  model?: string;
  /** Message metadata format — "xml" (default) or "bracket" (per-model config) */
  metadataFormat?: MetadataFormat;
  /** Orchestrator plan — persisted across LLM calls, injected after system prompt (Phase 3.3) */
  plan?: string;
};

// ---------------------------------------------------------------------------
// Effects — actions the engine adapter must execute
// ---------------------------------------------------------------------------

export type OrchestratorEffect =
  | { type: "start_agent"; agent: AgentId; task: string; context?: Record<string, unknown> }
  | { type: "send_directory"; agentWorkflowId: string; directory: AgentDirectoryPayload }
  | { type: "send_directive"; agentWorkflowId: string; directive: DirectivePayload }
  | { type: "call_llm"; messages: LLMMessage[]; tools?: LLMToolDefinition[] }
  | { type: "broadcast_to_agents"; excludeShortIds: string[]; content: string; fromAgentId: string }
  | { type: "save_state"; state: OrchestratorState }
  | { type: "cancel_agent"; agentWorkflowId: string }
  | { type: "terminate_agent"; agentWorkflowId: string }
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
    model: params.model,
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
    .map((a) => `- ${a.agent.shortId} (${a.agent.label}${a.agent.fileName ? `, file: ${a.agent.fileName}` : ""})`)
    .join("\n");

  const planningMessage: LLMMessage = {
    role: "user",
    content: `You are the orchestrator of a multi-agent collaboration. Your task:\n\n${state.task}\n\nAvailable agents:\n${agentList}\n\nPlan the work and assign directives to each agent. For each agent, write:\n[DIRECTIVE:#agentShortId]\nThe task for this agent...\n[/DIRECTIVE]\n\nBe specific about what each agent should do. Consider dependencies between tasks.`,
  };

  state.messageHistory.push(planningMessage);

  return {
    type: "call_llm",
    messages: buildOrchestratorMessages(state),
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
    event: { type: "orchestrator_text", content: llmResponse },
  });
  state.eventLog.push({ type: "orchestrator_text", content: llmResponse });

  for (const directive of directives) {
    const resolved = resolveAgent(state.agents, directive.agentShortId);
    if (!resolved || !resolved.agent.agent.workflowId) continue;
    const { key: shortId, agent: agentState } = resolved;

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
        agentShortId: shortId,
        content: directive.content,
      },
    });
    state.eventLog.push({
      type: "orchestrator_directive",
      agentShortId: shortId,
      content: directive.content,
    });
  }

  return effects;
}

// ---------------------------------------------------------------------------
// ShortId resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve an agent by shortId regardless of whether the LLM passed it with
 * "#", "##", or without any prefix. The map keys may or may not start with "#".
 */
function resolveAgent(
  agents: Map<string, AgentState>,
  rawShortId: string
): { key: string; agent: AgentState } | null {
  // Try as-is first
  const direct = agents.get(rawShortId);
  if (direct) return { key: rawShortId, agent: direct };

  // Strip all leading # and try without
  const stripped = rawShortId.replace(/^#+/, "");
  const withoutHash = agents.get(stripped);
  if (withoutHash) return { key: stripped, agent: withoutHash };

  // Try with single # prefix
  const withHash = agents.get(`#${stripped}`);
  if (withHash) return { key: `#${stripped}`, agent: withHash };

  // Fuzzy match: LLMs often send just the unique suffix (e.g. "pomipo" for "#Figma-Desktop-pomipo")
  for (const [key, agent] of agents) {
    if (key.endsWith(`-${stripped}`) || key.endsWith(`-${rawShortId}`)) {
      return { key, agent };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Orchestrator tools (structured directive sending)
// ---------------------------------------------------------------------------

export function getOrchestratorTools(state: OrchestratorState): LLMToolDefinition[] {
  const agentIds = Array.from(state.agents.keys());
  return [
    {
      name: "send_agent_directive",
      description:
        "Send a specific directive/task to one agent. " +
        `Available agents: ${agentIds.join(", ")}`,
      parameters: {
        type: "object",
        properties: {
          agentShortId: {
            type: "string",
            description: "Short ID of the target agent",
          },
          content: {
            type: "string",
            description: "The specific task/directive for this agent",
          },
          expectedResult: {
            type: "string",
            description: "What the agent should achieve (optional)",
          },
        },
        required: ["agentShortId", "content"],
      },
    },
    {
      name: "mark_agent_done",
      description: "Mark an agent as done when its work is satisfactory.",
      parameters: {
        type: "object",
        properties: {
          agentShortId: {
            type: "string",
            description: "Short ID of the agent to mark as done",
          },
        },
        required: ["agentShortId"],
      },
    },
    {
      name: "broadcast_to_agents",
      description: "Send a message to all active agents.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Message content",
          },
        },
        required: ["content"],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Phase 3 (new): System brief + first orchestrator LLM call with tools
// ---------------------------------------------------------------------------

/**
 * Injects deterministic context into the orchestrator's message history
 * and returns a call_llm effect with tools so the orchestrator can
 * assign directives via structured tool calls.
 *
 * No synthetic assistant message — the LLM responds itself.
 */
export function generateBriefAndFirstCall(state: OrchestratorState): OrchestratorEffect[] {
  const agents = Array.from(state.agents.values()).map((a) => a.agent);
  const effects: OrchestratorEffect[] = [];

  // 1. System prompt
  const systemPromptContent = buildOrchestratorSystemPrompt(state.task, agents, state.metadataFormat);
  state.messageHistory.push({
    role: "system",
    content: systemPromptContent,
  });
  const spEvent = { type: "system_prompt" as const, content: systemPromptContent, targetRole: "orchestrator" as const };
  effects.push({ type: "emit_event", event: spEvent });
  state.eventLog.push(spEvent);

  // 2. Synthetic user brief
  const agentList = agents
    .map(
      (a) =>
        `- ${a.shortId} (${a.label}${a.fileName ? `, file: ${a.fileName}` : ""}, type: ${a.type})`
    )
    .join("\n");

  const briefContent =
    `New orchestration started.\n\n` +
    `## Task\n${state.task}\n\n` +
    `## Connected agents:\n${agentList}\n\n` +
    `All agents are connected and have been briefed on the overall task. ` +
    `Use the send_agent_directive tool to assign specific work to each agent now.`;

  state.messageHistory.push({
    role: "user",
    content: wrapMessage(briefContent, "guardian-engine", "orchestrator", "orchestrator_brief", state.metadataFormat),
  });

  // 3. Emit brief event so the UI shows the system kickoff
  effects.push({
    type: "emit_event",
    event: { type: "orchestrator_brief", content: briefContent },
  });
  state.eventLog.push({ type: "orchestrator_brief", content: briefContent });

  // 4. Return call_llm with tools
  effects.push({
    type: "call_llm",
    messages: buildOrchestratorMessages(state),
    tools: getOrchestratorTools(state),
  });

  return effects;
}

// ---------------------------------------------------------------------------
// Process orchestrator LLM response (tool calls + text fallback)
// ---------------------------------------------------------------------------

/**
 * Handles the orchestrator LLM response — both tool-call and text modes.
 *
 * - Tool calls: send directives, mark done, broadcast — inject results, signal continuation.
 * - Text only: fall back to AGENT_DONE markers + broadcast (existing behavior).
 */
export function processOrchestratorLLMResponse(
  state: OrchestratorState,
  content: string,
  toolCalls?: LLMToolCall[],
  reasoning?: string,
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
  intercepted?: { action: string; reason: string; originalModel?: string },
  reasoningSimulated?: boolean,
  modelId?: string
): OrchestratorEffect[] {
  state.messageHistory.push({ role: "assistant", content, toolCalls });

  // Update plan from orchestrator's response (Phase 3.3)
  updatePlanFromResponse(state, content, toolCalls);

  const effects: OrchestratorEffect[] = [];
  let usageAttached = false;

  // Log reasoning (model internal thinking, e.g. kimi-k2.5)
  if (reasoning?.trim()) {
    const event = { type: "orchestrator_reasoning" as const, content: reasoning, modelId, simulated: reasoningSimulated || undefined, usage: !usageAttached ? usage : undefined, intercepted };
    if (usage) usageAttached = true;
    effects.push({ type: "emit_event", event });
    state.eventLog.push(event);
  }

  // Log text content (the model's visible response)
  const hadReasoning = !!reasoning?.trim();
  if (content.trim()) {
    const event = { type: "orchestrator_text" as const, content, modelId, hadReasoning: hadReasoning || undefined, usage: !usageAttached ? usage : undefined, intercepted: !usageAttached ? intercepted : undefined };
    if (usage) usageAttached = true;
    effects.push({ type: "emit_event", event });
    state.eventLog.push(event);
  }

  // ── Text-only response (no tool calls) ──────────────────────────────
  if (!toolCalls || toolCalls.length === 0) {
    // Detect LLMs that write tool calls as text instead of structured tool_use.
    // Same nudge as agent-logic.ts — shared guardian rule for orchestration mode.
    const calledToolInText = /\[Called tool:\s*(\w+)\s*\(/.exec(content);
    if (calledToolInText) {
      const toolName = calledToolInText[1];
      const nudge = `You wrote a tool call in your text response instead of using a structured tool call. ` +
        `Do NOT write "[Called tool: ...]" in text — instead, invoke the tool "${toolName}" directly using the tool_use mechanism.`;
      const wrappedNudge = wrapMessage(nudge, "guardian-engine", "orchestrator", "guardian_feedback", state.metadataFormat);
      state.messageHistory.push({ role: "user", content: wrappedNudge });
      const fbEvent = { type: "guardian_feedback" as const, content: nudge, targetRole: "orchestrator" as const };
      effects.push({ type: "emit_event", event: fbEvent });
      state.eventLog.push(fbEvent);
      // Retry LLM — don't broadcast the broken text to agents
      effects.push({ type: "call_llm", messages: buildOrchestratorMessages(state), tools: getOrchestratorTools(state) });
      return effects;
    }

    // Legacy fallback: parse [DIRECTIVE] blocks (backward compat with models that use text)
    const directives = parseDirectives(content);
    for (const directive of directives) {
      const resolved = resolveAgent(state.agents, directive.agentShortId);
      if (!resolved || !resolved.agent.agent.workflowId) continue;
      const { key: shortId, agent: agentState } = resolved;

      // Guard: skip terminated agents in text-based directive fallback
      if (agentState.confirmedByAgent &&
          (agentState.status === "failed" || agentState.status === "completed" || agentState.status === "interrupted")) {
        continue;
      }

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
          agentShortId: shortId,
          content: directive.content,
        },
      });
      state.eventLog.push({
        type: "orchestrator_directive",
        agentShortId: shortId,
        content: directive.content,
      });
    }

    // Parse [AGENT_DONE] markers
    const doneMarkers = parseAgentDoneMarkers(content);
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

    // Broadcast to active agents (if no directives were parsed)
    // Skip short ack messages — they add no information and cause agent wakeup spam.
    // Only broadcast substantive text (>100 chars or containing actionable info).
    if (directives.length === 0 && content.length > 100) {
      const activeAgents = Array.from(state.agents.values()).filter(
        (a) => a.status === "active"
      );
      if (activeAgents.length > 0) {
        effects.push({
          type: "broadcast_to_agents",
          excludeShortIds: doneMarkers,
          content,
          fromAgentId: "orchestrator",
        });
      }
    }

    return effects;
  }

  // ── Tool calls ────────────────────────────────────────────────────────
  for (const tc of toolCalls) {
    // Emit tool call event for UI visibility
    const toolCallEvent = {
      type: "orchestrator_tool_call" as const,
      toolName: tc.name,
      args: tc.arguments,
    };
    effects.push({ type: "emit_event", event: toolCallEvent });
    state.eventLog.push(toolCallEvent);

    switch (tc.name) {
      case "send_agent_directive": {
        const args = tc.arguments as {
          agentShortId: string;
          content: string;
          expectedResult?: string;
        };
        const resolved = resolveAgent(state.agents, args.agentShortId);

        if (resolved && resolved.agent.agent.workflowId) {
          const { key: shortId, agent: agentState } = resolved;

          // Guard: do not send a new directive while the agent is still working on one.
          // Allow if: no lastReport yet (first directive) OR lastReport says directive is done (standby).
          const hasActiveWork = agentState.status === "active" &&
            agentState.lastReport != null &&
            agentState.lastReport.status !== "completed" &&
            agentState.lastReport.status !== "directive_done";
          if (hasActiveWork) {
            const errMsg = `Agent ${shortId} is still working on a directive (status: active). ` +
              `Wait for the agent to report "completed" before sending a new directive.`;
            state.messageHistory.push({
              role: "tool",
              content: `${errMsg}\n---\n${JSON.stringify({ success: false, error: errMsg })}`,
              toolCallId: tc.id,
            });
            effects.push({ type: "emit_event", event: { type: "orchestrator_tool_result", toolName: tc.name, result: errMsg, isError: true } });
            state.eventLog.push({ type: "orchestrator_tool_result", toolName: tc.name, result: errMsg, isError: true });
            break;
          }

          // Guard: do not send directives to agents whose workflow has terminated
          if (agentState.confirmedByAgent &&
              (agentState.status === "failed" || agentState.status === "completed" || agentState.status === "interrupted")) {
            const errMsg = `Agent ${shortId} has already ${agentState.status} and cannot receive new directives. ` +
              `Its workflow has terminated. Consider using a different agent or completing the orchestration.`;
            state.messageHistory.push({
              role: "tool",
              content: `${errMsg}\n---\n${JSON.stringify({ success: false, error: errMsg })}`,
              toolCallId: tc.id,
            });
            effects.push({ type: "emit_event", event: { type: "orchestrator_tool_result", toolName: tc.name, result: errMsg, isError: true } });
            state.eventLog.push({ type: "orchestrator_tool_result", toolName: tc.name, result: errMsg, isError: true });
            break;
          }

          agentState.status = "active";
          // Mark as working so the guard blocks duplicate directives in the same LLM response
          agentState.lastReport = { status: "in_progress", summary: "Directive sent, waiting for agent.", timestamp: new Date().toISOString() };
          const payload: DirectivePayload = {
            directiveId: `dir-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            content: args.content,
            context: state.context,
            expectedResult: args.expectedResult,
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
              agentShortId: shortId,
              content: args.content,
            },
          });
          state.eventLog.push({
            type: "orchestrator_directive",
            agentShortId: shortId,
            content: args.content,
          });
          const successMsg = `Directive sent to ${shortId}. Agent is now working — wait for their report.`;
          state.messageHistory.push({
            role: "tool",
            content: `${successMsg}\n---\n${JSON.stringify({ success: true })}`,
            toolCallId: tc.id,
          });
          effects.push({ type: "emit_event", event: { type: "orchestrator_tool_result", toolName: tc.name, result: successMsg, isError: false } });
          state.eventLog.push({ type: "orchestrator_tool_result", toolName: tc.name, result: successMsg, isError: false });
        } else {
          const errorMsg = `Agent ${args.agentShortId} not found or has no workflow.`;
          state.messageHistory.push({
            role: "tool",
            content: `${errorMsg}\n---\n${JSON.stringify({ success: false })}`,
            toolCallId: tc.id,
          });
          effects.push({ type: "emit_event", event: { type: "orchestrator_tool_result", toolName: tc.name, result: errorMsg, isError: true } });
          state.eventLog.push({ type: "orchestrator_tool_result", toolName: tc.name, result: errorMsg, isError: true });
        }
        break;
      }

      case "mark_agent_done": {
        const args = tc.arguments as { agentShortId: string };
        const resolved = resolveAgent(state.agents, args.agentShortId);

        if (resolved) {
          const { key: shortId, agent: agentState } = resolved;

          // Pre-check: block mark_done only if the agent reported a directive-level failure
          // but its workflow is still alive — the orchestrator should retry instead of giving up.
          // When the workflow has already terminated (status === "failed"), allow mark_done so
          // the orchestrator can acknowledge the failure and complete the orchestration.
          const lastReport = agentState.lastReport;
          const workflowTerminated = agentState.status === "failed" || agentState.status === "completed" || agentState.status === "interrupted";
          if (!workflowTerminated && lastReport && (lastReport.status === "failed" || (lastReport.summary && lastReport.summary.includes("FAILED")))) {
            const blockMsg = `Cannot mark agent ${shortId} as done — its last report indicates failure: "${(lastReport.summary ?? "").slice(0, 200)}". ` +
              `Send a new directive to retry, or acknowledge the failure.`;
            state.messageHistory.push({
              role: "tool",
              content: `${blockMsg}\n---\n${JSON.stringify({ success: false, reason: "agent_failed" })}`,
              toolCallId: tc.id,
            });
            effects.push({ type: "emit_event", event: { type: "orchestrator_tool_result", toolName: tc.name, result: blockMsg, isError: true } });
            state.eventLog.push({ type: "orchestrator_tool_result", toolName: tc.name, result: blockMsg, isError: true });
            break;
          }

          // If the agent's workflow already terminated as failed, just acknowledge —
          // do not flip status to "completed" (preserve the failure in the audit trail)
          // and skip terminate_agent (the workflow is already gone).
          const wasFailed = agentState.status === "failed";
          if (!wasFailed) {
            agentState.status = "completed";
          }
          agentState.confirmedByAgent = true;
          if (!wasFailed && agentState.agent.workflowId) {
            effects.push({
              type: "terminate_agent",
              agentWorkflowId: agentState.agent.workflowId,
            });
          }
          if (!wasFailed) {
            effects.push({
              type: "emit_event",
              event: {
                type: "agent_status_changed",
                agentShortId: shortId,
                status: "completed",
              },
            });
            state.eventLog.push({
              type: "agent_status_changed",
              agentShortId: shortId,
              status: "completed",
            });
          }
          const doneMsg = wasFailed
            ? `Agent ${shortId} failure acknowledged. (Workflow already terminated.)`
            : `Agent ${shortId} marked as done and terminated.`;
          state.messageHistory.push({
            role: "tool",
            content: `${doneMsg}\n---\n${JSON.stringify({ success: true, status: wasFailed ? "failed_acknowledged" : "completed" })}`,
            toolCallId: tc.id,
          });
          effects.push({ type: "emit_event", event: { type: "orchestrator_tool_result", toolName: tc.name, result: doneMsg, isError: false } });
          state.eventLog.push({ type: "orchestrator_tool_result", toolName: tc.name, result: doneMsg, isError: false });
        } else {
          const notFoundMsg = `Agent ${args.agentShortId} not found.`;
          state.messageHistory.push({
            role: "tool",
            content: `${notFoundMsg}\n---\n${JSON.stringify({ success: false })}`,
            toolCallId: tc.id,
          });
          effects.push({ type: "emit_event", event: { type: "orchestrator_tool_result", toolName: tc.name, result: notFoundMsg, isError: true } });
          state.eventLog.push({ type: "orchestrator_tool_result", toolName: tc.name, result: notFoundMsg, isError: true });
        }
        break;
      }

      case "broadcast_to_agents": {
        const args = tc.arguments as { content: string };

        // Identify which agents will actually receive the broadcast (only active ones)
        const activeRecipients = Array.from(state.agents.entries())
          .filter(([, a]) => a.status === "active")
          .map(([id]) => id);
        const terminatedAgents = Array.from(state.agents.entries())
          .filter(([, a]) => a.confirmedByAgent && (a.status === "failed" || a.status === "completed" || a.status === "interrupted"))
          .map(([id, a]) => `${id} (${a.status})`);

        effects.push({
          type: "broadcast_to_agents",
          excludeShortIds: [],
          content: args.content,
          fromAgentId: "orchestrator",
        });

        let broadcastMsg = activeRecipients.length > 0
          ? `Broadcast sent to active agents: ${activeRecipients.join(", ")}.`
          : "No active agents to receive the broadcast.";
        if (terminatedAgents.length > 0) {
          broadcastMsg += ` Skipped terminated agents: ${terminatedAgents.join(", ")}.`;
        }

        state.messageHistory.push({
          role: "tool",
          content: `${broadcastMsg}\n---\n${JSON.stringify({ success: activeRecipients.length > 0 })}`,
          toolCallId: tc.id,
        });
        effects.push({ type: "emit_event", event: { type: "orchestrator_tool_result", toolName: tc.name, result: broadcastMsg, isError: false } });
        state.eventLog.push({ type: "orchestrator_tool_result", toolName: tc.name, result: broadcastMsg, isError: false });
        break;
      }

      default: {
        const unknownMsg = `Unknown tool: ${tc.name}`;
        state.messageHistory.push({
          role: "tool",
          content: `${unknownMsg}\n---\n${JSON.stringify({ success: false })}`,
          toolCallId: tc.id,
        });
        effects.push({ type: "emit_event", event: { type: "orchestrator_tool_result", toolName: tc.name, result: unknownMsg, isError: true } });
        state.eventLog.push({ type: "orchestrator_tool_result", toolName: tc.name, result: unknownMsg, isError: true });
        break;
      }
    }
  }

  // NOTE: The directive guard in send_agent_directive already blocks sending
  // to busy agents (lastReport.status !== "completed"/"directive_done").
  // No need for an extra "wait" nudge here — it was previously injected every
  // time all agents were active, which incorrectly blocked follow-up directives
  // after directive_done reports.

  // Signal continuation — LLM needs to see tool results
  effects.push({
    type: "call_llm",
    messages: buildOrchestratorMessages(state),
    tools: getOrchestratorTools(state),
  });

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
    // Update plan with report information (Phase 3.3)
    updatePlanFromReport(state, report);

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
    const reportBody = `[status: ${report.status}]${report.summary ? `\n${report.summary}` : ""}`;
    const reportMsg = wrapMessage(reportBody, agentSource(report.agentShortId), "orchestrator", "agent_report", state.metadataFormat);
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

  // Ask LLM to evaluate reports (with tools for follow-up directives)
  effects.push({
    type: "call_llm",
    messages: buildOrchestratorMessages(state),
    tools: getOrchestratorTools(state),
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
    event: { type: "orchestrator_text", content: llmResponse },
  });
  state.eventLog.push({ type: "orchestrator_text", content: llmResponse });

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
    const target = input.targetAgentId ? agentSource(input.targetAgentId) : "orchestrator";
    state.messageHistory.push({
      role: "user",
      content: wrapMessage(input.content, "user", target as "orchestrator", "user_input", state.metadataFormat),
    });
  }

  // Let LLM process user input (with tools for directives)
  effects.push({
    type: "call_llm",
    messages: buildOrchestratorMessages(state),
    tools: getOrchestratorTools(state),
  });

  return effects;
}

// ---------------------------------------------------------------------------
// Cleanup idle agents
// ---------------------------------------------------------------------------

/**
 * Auto-complete agents that never received a directive once every agent that
 * DID receive one has reached a terminal+confirmed state. The orchestrator LLM
 * sometimes "forgets" to mark_agent_done a silent agent (e.g. a Designer that
 * was never asked to review), which leaves the orchestration Running until
 * timeout. This pass finalizes them so checkCompletion can succeed.
 *
 * Safety guards (all required):
 *  - At least one agent must already be terminal+confirmed (orchestration has done work).
 *  - Every non-idle agent (lastReport != null) must be terminal+confirmed.
 * Without these, we'd risk marking agents done before the orchestrator had a
 * chance to dispatch directives.
 */
export function cleanupIdleAgents(state: OrchestratorState): OrchestratorEffect[] {
  const effects: OrchestratorEffect[] = [];

  const isTerminalConfirmed = (a: AgentState) =>
    a.confirmedByAgent && (a.status === "completed" || a.status === "failed" || a.status === "interrupted");

  const idleAgents = Array.from(state.agents.entries()).filter(
    ([, a]) => a.lastReport == null && !a.confirmedByAgent && a.status !== "completed" && a.status !== "failed" && a.status !== "interrupted"
  );
  if (idleAgents.length === 0) return effects;

  const allValues = Array.from(state.agents.values());
  const hasTerminalAgent = allValues.some(isTerminalConfirmed);
  if (!hasTerminalAgent) return effects;

  const everyDirectiveAgentDone = allValues.every(
    (a) => a.lastReport == null || isTerminalConfirmed(a)
  );
  if (!everyDirectiveAgentDone) return effects;

  for (const [shortId, agent] of idleAgents) {
    agent.status = "completed";
    agent.confirmedByAgent = true;
    if (agent.agent.workflowId) {
      effects.push({ type: "terminate_agent", agentWorkflowId: agent.agent.workflowId });
    }
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
    const agents = Array.from(state.agents.values());
    const failedCount = agents.filter((a) => a.status === "failed").length;
    const totalCount = agents.length;

    if (failedCount === totalCount) {
      state.status = "failed";
    } else if (failedCount > 0) {
      state.status = "completed_with_errors";
    } else {
      state.status = "completed";
    }

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
    status: state.status === "active" ? "completed" : state.status as OrchestrationResult["status"],
    agentResults,
    durationMs: Date.now() - state.startedAt,
  };
}
