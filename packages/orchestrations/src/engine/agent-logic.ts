/**
 * Agent workflow logic — engine-agnostic.
 *
 * This module contains the pure business logic for an agent workflow.
 * It operates on state and produces effects that the engine adapter executes.
 */

import type {
  DirectivePayload,
  PeerMessagePayload,
  BroadcastPayload,
  SubConvInvitePayload,
  SubConvMessagePayload,
  SubConvClosePayload,
  SubConvResponsePayload,
  AgentDirectoryPayload,
  AgentReportPayload,
  AgentId,
  AgentActivity,
} from "../types/signals.js";
import type { LLMMessage, LLMToolCall, LLMToolDefinition, SubConversationState } from "../types/agents.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_STEPS = 20;

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------

export type AgentWorkflowState = {
  /** Agent identity */
  agent: AgentId;
  /** Orchestrator's workflow ID */
  orchestratorWorkflowId: string;
  /** Agent directory (shortId → AgentId) */
  agentDirectory: Map<string, AgentId>;
  /** LLM conversation history */
  messageHistory: LLMMessage[];
  /** Queued directives from the orchestrator */
  directiveQueue: DirectivePayload[];
  /** Queued peer-to-peer messages */
  peerMessageQueue: PeerMessagePayload[];
  /** Queued broadcast messages */
  broadcastQueue: BroadcastPayload[];
  /** Queued sub-conversation messages */
  subConvMessageQueue: SubConvMessagePayload[];
  /** Active sub-conversation (max 1) */
  subConvActive: SubConversationState | null;
  /** Whether the plugin has disconnected */
  disconnected: boolean;
  /** Whether the agent has completed its task */
  completed: boolean;
  /** Step counter for LLM loop */
  stepCount: number;
  /** Code awaiting LLM self-review before execution */
  pendingFigmaCode: { code: string; toolCallId: string } | null;
  /** Pending code_executed activities to include in the next batch */
  pendingCodeResults: AgentActivity[];
};

// ---------------------------------------------------------------------------
// Effects — actions the engine adapter must execute
// ---------------------------------------------------------------------------

export type AgentEffect =
  | { type: "call_llm"; messages: LLMMessage[]; tools: LLMToolDefinition[] }
  | { type: "execute_figma_code"; pluginClientId: string; userId: string; code: string }
  | { type: "report_to_orchestrator"; report: AgentReportPayload }
  | { type: "send_peer_message"; targetWorkflowId: string; message: PeerMessagePayload }
  | { type: "send_broadcast"; broadcast: BroadcastPayload }
  | { type: "send_sub_conv_invite"; targetWorkflowIds: string[]; invite: SubConvInvitePayload }
  | { type: "send_sub_conv_response"; targetWorkflowId: string; response: SubConvResponsePayload }
  | { type: "send_sub_conv_message"; targetWorkflowIds: string[]; message: SubConvMessagePayload }
  | { type: "send_sub_conv_close"; targetWorkflowIds: string[]; close: SubConvClosePayload }
  | { type: "notify_orchestrator_sub_conv"; event: "opened" | "closed"; subConvId: string; participantIds: string[]; topic?: string; reason?: "completed" | "timeout" | "cancelled" }
  | { type: "emit_activity"; activities: AgentActivity[] }
  | { type: "wait_for_input" }
  | { type: "complete" };

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function createAgentState(agent: AgentId): AgentWorkflowState {
  return {
    agent,
    orchestratorWorkflowId: "",
    agentDirectory: new Map(),
    messageHistory: [],
    directiveQueue: [],
    peerMessageQueue: [],
    broadcastQueue: [],
    subConvMessageQueue: [],
    subConvActive: null,
    disconnected: false,
    completed: false,
    stepCount: 0,
    pendingFigmaCode: null,
    pendingCodeResults: [],
  };
}

// ---------------------------------------------------------------------------
// Signal handlers (mutate state)
// ---------------------------------------------------------------------------

export function handleDirective(state: AgentWorkflowState, directive: DirectivePayload): void {
  state.directiveQueue.push(directive);
}

export function handlePeerMessage(state: AgentWorkflowState, message: PeerMessagePayload): void {
  state.peerMessageQueue.push(message);
}

export function handleBroadcast(state: AgentWorkflowState, broadcast: BroadcastPayload): void {
  state.broadcastQueue.push(broadcast);
}

export function handleSubConvMessage(state: AgentWorkflowState, message: SubConvMessagePayload): void {
  state.subConvMessageQueue.push(message);
}

export function handleAgentDirectory(state: AgentWorkflowState, directory: AgentDirectoryPayload): void {
  state.agentDirectory = new Map(Object.entries(directory.agents));
  state.orchestratorWorkflowId = directory.orchestratorWorkflowId;
}

export function handlePluginDisconnected(state: AgentWorkflowState): void {
  state.disconnected = true;
}

// ---------------------------------------------------------------------------
// Handle sub-conversation invite
// ---------------------------------------------------------------------------

export function handleSubConvInvite(
  state: AgentWorkflowState,
  invite: SubConvInvitePayload
): AgentEffect | null {
  if (state.subConvActive !== null) {
    // Already in a sub-conversation, decline
    const initiator = state.agentDirectory.get(invite.initiatorId);
    if (initiator?.workflowId) {
      return {
        type: "send_sub_conv_response",
        targetWorkflowId: initiator.workflowId,
        response: {
          subConvId: invite.subConvId,
          agentId: state.agent.shortId,
          accepted: false,
        },
      };
    }
    return null;
  }

  // Accept the invitation
  state.subConvActive = {
    id: invite.subConvId,
    initiatorId: invite.initiatorId,
    participantIds: invite.participantIds,
    topic: invite.topic,
    durationMs: invite.durationMs,
    startedAt: new Date().toISOString(),
  };

  const initiator = state.agentDirectory.get(invite.initiatorId);
  if (initiator?.workflowId) {
    return {
      type: "send_sub_conv_response",
      targetWorkflowId: initiator.workflowId,
      response: {
        subConvId: invite.subConvId,
        agentId: state.agent.shortId,
        accepted: true,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Handle sub-conversation close
// ---------------------------------------------------------------------------

export function handleSubConvClose(state: AgentWorkflowState, close: SubConvClosePayload): void {
  if (state.subConvActive?.id === close.subConvId) {
    state.subConvActive = null;
  }
}

// ---------------------------------------------------------------------------
// Process all queued inputs and generate LLM call
// ---------------------------------------------------------------------------

export function processQueues(state: AgentWorkflowState): AgentEffect[] {
  const effects: AgentEffect[] = [];
  let hasNewInput = false;

  // Process directives
  while (state.directiveQueue.length > 0) {
    const directive = state.directiveQueue.shift()!;
    state.messageHistory.push({
      role: "user",
      content: `[Orchestrator task] ${directive.content}${directive.expectedResult ? `\n\nExpected result: ${directive.expectedResult}` : ""}`,
    });
    hasNewInput = true;
  }

  // Process peer messages
  while (state.peerMessageQueue.length > 0) {
    const msg = state.peerMessageQueue.shift()!;
    state.messageHistory.push({
      role: "user",
      content: `[Message from #${msg.fromAgentId}] ${msg.content}`,
    });
    hasNewInput = true;
  }

  // Process broadcast messages
  while (state.broadcastQueue.length > 0) {
    const msg = state.broadcastQueue.shift()!;
    state.messageHistory.push({
      role: "user",
      content: `[Broadcast from #${msg.fromAgentId}] ${msg.content}`,
    });
    hasNewInput = true;
  }

  // Process sub-conversation messages
  while (state.subConvMessageQueue.length > 0) {
    const msg = state.subConvMessageQueue.shift()!;
    state.messageHistory.push({
      role: "user",
      content: `[Sub-conversation with #${msg.fromAgentId}] ${msg.content}`,
    });
    hasNewInput = true;
  }

  // Plugin disconnect
  if (state.disconnected && !state.completed) {
    state.completed = true;
    effects.push({
      type: "report_to_orchestrator",
      report: {
        agentShortId: state.agent.shortId,
        status: "interrupted",
        summary: "Plugin disconnected during execution.",
      },
    });
    effects.push({ type: "complete" });
    return effects;
  }

  if (!hasNewInput) {
    effects.push({ type: "wait_for_input" });
    return effects;
  }

  // Generate LLM call with agent tools
  effects.push({
    type: "call_llm",
    messages: [...state.messageHistory],
    tools: getAgentTools(state),
  });

  return effects;
}

// ---------------------------------------------------------------------------
// Process LLM response (may trigger tool calls)
// ---------------------------------------------------------------------------

export function processLLMResponse(
  state: AgentWorkflowState,
  content: string,
  toolCalls?: LLMToolCall[]
): AgentEffect[] {
  state.messageHistory.push({
    role: "assistant",
    content,
    toolCalls,
  });
  state.stepCount++;

  const effects: AgentEffect[] = [];
  const activities: AgentActivity[] = [];

  // Emit thinking activity if there's content
  if (content.trim()) {
    activities.push({ action: "thinking", content });
  }

  if (!toolCalls || toolCalls.length === 0) {
    // Detect LLMs that write tool calls as text instead of invoking them.
    // kimi-k2.5 commonly outputs '{ "tool": "signal_task_complete", ... }'
    // as plain text. Parse it and treat it as a real tool call.
    if (/signal_task_complete/i.test(content) && !state.completed) {
      let summary = "Task completed.";
      try {
        const parsed = JSON.parse(content);
        if (parsed.summary) summary = parsed.summary;
      } catch {
        const match = content.match(/["']summary["']\s*:\s*["']([^"']+)["']/);
        if (match) summary = match[1];
      }
      activities.push({ action: "tool_call", toolName: "signal_task_complete", summary: `(auto-detected from text) ${summary}` });
      if (activities.length > 0) {
        effects.push({ type: "emit_activity", activities });
      }
      state.completed = true;
      effects.push({
        type: "report_to_orchestrator",
        report: {
          agentShortId: state.agent.shortId,
          status: "completed",
          summary,
        },
      });
      effects.push({ type: "complete" });
      return effects;
    }

    // No tool calls — report in-progress and wait
    if (activities.length > 0) {
      effects.push({ type: "emit_activity", activities });
    }
    effects.push({
      type: "report_to_orchestrator",
      report: {
        agentShortId: state.agent.shortId,
        status: "in_progress",
        summary: content,
      },
    });
    effects.push({ type: "wait_for_input" });
    return effects;
  }

  for (const tc of toolCalls) {
    const { effects: toolEffects, activities: toolActivities } = processToolCall(state, tc);
    effects.push(...toolEffects);
    activities.push(...toolActivities);
  }

  // Emit all collected activities as a single batch
  if (activities.length > 0) {
    effects.push({ type: "emit_activity", activities });
  }

  // If not completed and under step limit, continue LLM loop
  if (!state.completed && state.stepCount < MAX_STEPS) {
    effects.push({
      type: "call_llm",
      messages: [...state.messageHistory],
      tools: getAgentTools(state),
    });
  } else if (state.stepCount >= MAX_STEPS && !state.completed) {
    state.completed = true;
    effects.push({
      type: "report_to_orchestrator",
      report: {
        agentShortId: state.agent.shortId,
        status: "failed",
        summary: `Agent could not complete the task within ${MAX_STEPS} steps. It may have been stuck retrying a failing operation.`,
      },
    });
    effects.push({ type: "complete" });
  }

  return effects;
}

// ---------------------------------------------------------------------------
// Inject tool result into history
// ---------------------------------------------------------------------------

export function injectToolResult(
  state: AgentWorkflowState,
  toolCallId: string,
  result: string
): void {
  state.messageHistory.push({
    role: "tool",
    content: result,
    toolCallId,
  });
}

// ---------------------------------------------------------------------------
// Pre-execution code review (Figma API linter)
// ---------------------------------------------------------------------------

/**
 * Validates generated Figma Plugin API code BEFORE execution.
 * Returns an array of issues. Empty = code is OK to execute.
 *
 * This is a structural gate — it catches known LLM mistakes early so
 * the agent doesn't waste steps on code that will always fail.
 */
export function reviewFigmaCode(code: string): string[] {
  const issues: string[] = [];

  // Rule 1: 'a' (alpha) in color objects — Figma uses { r, g, b }, not { r, g, b, a }
  if (/color\s*:\s*\{[^}]*\ba\s*:/i.test(code)) {
    issues.push(
      'Color objects in fills/strokes must use { r, g, b } — NOT { r, g, b, a }. ' +
      'Remove the "a" key. Use paint-level "opacity" instead if needed.'
    );
  }

  // Rule 2: figma.closePlugin() — kills the bridge
  if (/figma\s*\.\s*closePlugin\s*\(/.test(code)) {
    issues.push(
      'figma.closePlugin() is forbidden — it kills the plugin bridge. Remove this call.'
    );
  }

  // Rule 3: figma.currentPage = ... (sync setter removed in newer API)
  if (/figma\s*\.\s*currentPage\s*=\s*/.test(code)) {
    issues.push(
      'figma.currentPage = ... is not allowed with dynamic-page access. ' +
      'Use await figma.setCurrentPageAsync(page) instead.'
    );
  }

  // Rule 4: .children = [...] (read-only property)
  if (/\.children\s*=\s*\[/.test(code)) {
    issues.push(
      'node.children is read-only. You cannot assign to it. ' +
      'Use node.appendChild(child) or node.insertChild(index, child) instead.'
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Process individual tool call
// ---------------------------------------------------------------------------

function processToolCall(
  state: AgentWorkflowState,
  tc: LLMToolCall
): { effects: AgentEffect[]; activities: AgentActivity[] } {
  const effects: AgentEffect[] = [];
  const activities: AgentActivity[] = [];

  switch (tc.name) {
    case "signal_task_complete": {
      state.completed = true;
      const args = tc.arguments as { summary?: string };
      activities.push({ action: "tool_call", toolName: tc.name, summary: args.summary ?? "Task completed." });
      effects.push({
        type: "report_to_orchestrator",
        report: {
          agentShortId: state.agent.shortId,
          status: "completed",
          summary: args.summary ?? "Task completed.",
        },
      });
      effects.push({ type: "complete" });
      break;
    }

    case "send_peer_message": {
      const args = tc.arguments as { targetAgentId: string; content: string };
      activities.push({ action: "tool_call", toolName: tc.name, summary: `→ ${args.targetAgentId}: ${args.content}` });
      const target = state.agentDirectory.get(args.targetAgentId);
      if (target?.workflowId) {
        effects.push({
          type: "send_peer_message",
          targetWorkflowId: target.workflowId,
          message: {
            fromAgentId: state.agent.shortId,
            content: args.content,
          },
        });
      }
      break;
    }

    case "broadcast_message": {
      const args = tc.arguments as { content: string };
      activities.push({ action: "tool_call", toolName: tc.name, summary: args.content });
      effects.push({
        type: "send_broadcast",
        broadcast: {
          fromAgentId: state.agent.shortId,
          content: args.content,
        },
      });
      break;
    }

    case "start_sub_conversation": {
      const args = tc.arguments as { participantIds: string[]; topic: string; durationMs?: number };
      activities.push({ action: "tool_call", toolName: tc.name, summary: `topic: ${args.topic}` });
      if (state.subConvActive === null) {
        const subConvId = `subconv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const durationMs = args.durationMs ?? 120_000;

        state.subConvActive = {
          id: subConvId,
          initiatorId: state.agent.shortId,
          participantIds: args.participantIds,
          topic: args.topic,
          durationMs,
          startedAt: new Date().toISOString(),
        };

        const targetWorkflowIds = args.participantIds
          .map((id) => state.agentDirectory.get(id)?.workflowId)
          .filter((wid): wid is string => !!wid);

        effects.push({
          type: "send_sub_conv_invite",
          targetWorkflowIds,
          invite: {
            subConvId,
            initiatorId: state.agent.shortId,
            participantIds: args.participantIds,
            topic: args.topic,
            durationMs,
          },
        });

        effects.push({
          type: "notify_orchestrator_sub_conv",
          event: "opened",
          subConvId,
          participantIds: [state.agent.shortId, ...args.participantIds],
          topic: args.topic,
        });
      }
      break;
    }

    case "close_sub_conversation": {
      activities.push({ action: "tool_call", toolName: tc.name, summary: "Closing sub-conversation" });
      if (state.subConvActive) {
        const subConv = state.subConvActive;
        state.subConvActive = null;

        const targetWorkflowIds = subConv.participantIds
          .map((id) => state.agentDirectory.get(id)?.workflowId)
          .filter((wid): wid is string => !!wid);

        effects.push({
          type: "send_sub_conv_close",
          targetWorkflowIds,
          close: {
            subConvId: subConv.id,
            reason: "completed",
          },
        });

        effects.push({
          type: "notify_orchestrator_sub_conv",
          event: "closed",
          subConvId: subConv.id,
          participantIds: [state.agent.shortId, ...subConv.participantIds],
          reason: "completed",
        });
      }
      break;
    }

    case "figma_plugin_execute": {
      const args = tc.arguments as { code: string };
      activities.push({ action: "tool_call", toolName: tc.name, summary: args.code });

      // Phase 1: programmatic linter — instant, free
      const codeIssues = reviewFigmaCode(args.code);
      if (codeIssues.length > 0) {
        const linterFeedback = JSON.stringify({
          success: false,
          codeReview: codeIssues,
          error: `Code review rejected (${codeIssues.length} issue${codeIssues.length > 1 ? "s" : ""}). Fix and retry.`,
        });
        activities.push({ action: "code_review_rejected", issues: codeIssues, feedback: linterFeedback });
        activities.push({
          action: "guardian_message",
          recipient: `agent ${state.agent.shortId}`,
          message: linterFeedback,
        });
        injectToolResult(state, tc.id, linterFeedback);
        break;
      }

      // Phase 2: LLM self-review — store code, ask LLM to confirm
      activities.push({ action: "code_review_passed", codeSnippet: args.code });
      state.pendingFigmaCode = { code: args.code, toolCallId: tc.id };
      const selfReviewPrompt =
        "Code passed automated checks. Before execution, review it yourself:\n" +
        "1. Does the code match exactly what the directive asked for?\n" +
        "2. Are fills/strokes using { r, g, b } without 'a' (alpha)?\n" +
        "3. Is the code using correct Figma Plugin API methods?\n" +
        "4. Will the return value confirm what was done?\n\n" +
        "If the code is correct → call figma_confirm_execute()\n" +
        "If you spot an issue → call figma_plugin_execute() again with the fix.";
      activities.push({
        action: "guardian_message",
        recipient: `agent ${state.agent.shortId}`,
        message: selfReviewPrompt,
      });
      injectToolResult(
        state,
        tc.id,
        JSON.stringify({
          status: "pending_review",
          message: selfReviewPrompt,
          codeToReview: args.code,
        })
      );
      break;
    }

    case "figma_confirm_execute": {
      activities.push({ action: "tool_call", toolName: tc.name, summary: "Confirmed — executing" });
      if (!state.pendingFigmaCode) {
        injectToolResult(
          state,
          tc.id,
          JSON.stringify({
            success: false,
            error: "No code pending review. Call figma_plugin_execute() first.",
          })
        );
        break;
      }

      const pending = state.pendingFigmaCode;
      state.pendingFigmaCode = null;

      effects.push({
        type: "execute_figma_code",
        pluginClientId: state.agent.pluginClientId ?? "",
        userId: "",
        code: pending.code,
      });
      break;
    }
  }

  return { effects, activities };
}

// ---------------------------------------------------------------------------
// Agent tool definitions
// ---------------------------------------------------------------------------

function getAgentTools(state: AgentWorkflowState): LLMToolDefinition[] {
  const tools: LLMToolDefinition[] = [
    {
      name: "signal_task_complete",
      description: "Signal that you have completed your assigned task. Call this when your work is done.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Summary of the work completed" },
        },
      },
    },
    {
      name: "send_peer_message",
      description: "Send a message to a specific agent in the orchestration.",
      parameters: {
        type: "object",
        properties: {
          targetAgentId: { type: "string", description: "Short ID of the target agent (e.g. '#figma-1')" },
          content: { type: "string", description: "Message content" },
        },
        required: ["targetAgentId", "content"],
      },
    },
    {
      name: "broadcast_message",
      description: "Send a message to all agents in the orchestration.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Message content" },
        },
        required: ["content"],
      },
    },
    {
      name: "start_sub_conversation",
      description: "Start a scoped sub-conversation with one or more agents. You can only have one active sub-conversation at a time.",
      parameters: {
        type: "object",
        properties: {
          participantIds: {
            type: "array",
            items: { type: "string" },
            description: "Short IDs of agents to invite",
          },
          topic: { type: "string", description: "Topic of the sub-conversation" },
          durationMs: { type: "number", description: "Duration in milliseconds (default: 120000)" },
        },
        required: ["participantIds", "topic"],
      },
    },
  ];

  // Only add close_sub_conversation if one is active
  if (state.subConvActive) {
    tools.push({
      name: "close_sub_conversation",
      description: "Close the active sub-conversation.",
      parameters: {
        type: "object",
        properties: {},
      },
    });
  }

  // Add figma tools if agent has a plugin client
  if (state.agent.pluginClientId) {
    if (state.pendingFigmaCode) {
      // Code is pending review — only offer confirm or rewrite
      tools.push({
        name: "figma_confirm_execute",
        description:
          "Confirm and execute the code you submitted for review. " +
          "Call this ONLY after reviewing the code shown in the previous tool result. " +
          "If you found issues, call figma_plugin_execute() with corrected code instead.",
        parameters: {
          type: "object",
          properties: {},
        },
      });
      tools.push({
        name: "figma_plugin_execute",
        description:
          "Submit corrected code (replaces the pending code). " +
          "Use this if your review found issues with the previous submission.",
        parameters: {
          type: "object",
          properties: {
            code: { type: "string", description: "Corrected JavaScript code to execute in the Figma Plugin API" },
          },
          required: ["code"],
        },
      });
    } else {
      // Normal mode — submit code for review
      tools.push({
        name: "figma_plugin_execute",
        description:
          "Submit JavaScript code for review then execution in the Figma plugin. " +
          "The code will be checked before running. ONE small mutation per call (max ~30 lines). " +
          "Fills/strokes use { r, g, b } — NO 'a' (alpha) key in color objects.",
        parameters: {
          type: "object",
          properties: {
            code: { type: "string", description: "JavaScript code to execute in the Figma Plugin API" },
          },
          required: ["code"],
        },
      });
    }
  }

  return tools;
}
