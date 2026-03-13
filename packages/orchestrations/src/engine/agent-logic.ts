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

  if (!toolCalls || toolCalls.length === 0) {
    // No tool calls — report in-progress and wait
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
    const toolEffects = processToolCall(state, tc);
    effects.push(...toolEffects);
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
        status: "completed",
        summary: "Reached maximum step limit.",
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
// Process individual tool call
// ---------------------------------------------------------------------------

function processToolCall(state: AgentWorkflowState, tc: LLMToolCall): AgentEffect[] {
  const effects: AgentEffect[] = [];

  switch (tc.name) {
    case "signal_task_complete": {
      state.completed = true;
      const args = tc.arguments as { summary?: string };
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
      effects.push({
        type: "execute_figma_code",
        pluginClientId: state.agent.pluginClientId ?? "",
        userId: "", // Filled in by the engine adapter
        code: args.code,
      });
      break;
    }
  }

  return effects;
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

  // Add figma_plugin_execute if agent has a plugin client
  if (state.agent.pluginClientId) {
    tools.push({
      name: "figma_plugin_execute",
      description: "Execute JavaScript code in the connected Figma plugin. ONE small mutation per call (max ~30 lines).",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript code to execute in the Figma Plugin API" },
        },
        required: ["code"],
      },
    });
  }

  return tools;
}
