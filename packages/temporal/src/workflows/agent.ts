/**
 * Agent Temporal workflow.
 *
 * Thin adapter that wraps the engine-agnostic agent logic
 * with Temporal-specific APIs.
 */

import {
  condition,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  CancellationScope,
} from "@temporalio/workflow";

import {
  createAgentState,
  handleDirective,
  handlePeerMessage,
  handleBroadcast,
  handleSubConvMessage,
  handleAgentDirectory,
  handlePluginDisconnected,
  handleSubConvInvite,
  handleSubConvClose,
  processQueues,
  processLLMResponse,
  injectToolResult,
  type AgentWorkflowState,
  type AgentEffect,
  buildAgentSystemPrompt,
} from "@guardian/orchestrations";

import type { AgentId, LLMMessage } from "@guardian/orchestrations";
import type { AgentWorkflowInput } from "./types.js";

import {
  directiveSignal,
  peerMessageSignal,
  agentBroadcastSignal,
  subConvInviteSignal,
  subConvMessageSignal,
  subConvCloseSignal,
  subConvResponseSignal,
  agentDirectorySignal,
  pluginDisconnectedSignal,
  agentReportSignal,
  subConvNotifySignal,
  guardrailBlockedSignal,
  agentActivitySignal,
} from "../signals/definitions.js";

import type { LLMActivities, FigmaActivities } from "../activities/types.js";

// Proxy activities
const { callLLM } = proxyActivities<LLMActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

const { executeFigmaCode } = proxyActivities<FigmaActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 2 },
});

// ---------------------------------------------------------------------------
// Guardrail: notify orchestrator when plugin code is blocked
// ---------------------------------------------------------------------------

async function emitCodeExecuted(
  execResult: { success: boolean; error?: string; result?: unknown },
  state: AgentWorkflowState
): Promise<void> {
  try {
    const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
    await handle.signal(agentActivitySignal, {
      agentShortId: state.agent.shortId,
      activities: [{
        action: "code_executed" as const,
        success: execResult.success,
        summary: execResult.success
          ? `OK${execResult.result ? `: ${String(execResult.result).slice(0, 80)}` : ""}`
          : (execResult.error?.slice(0, 100) ?? "Execution failed"),
      }],
    });
  } catch {
    // Orchestrator may have already completed
  }
}

async function notifyGuardrailIfBlocked(
  execResult: { success: boolean; error?: string },
  state: AgentWorkflowState
): Promise<void> {
  if (execResult.success) return;
  if (!execResult.error?.startsWith("BLOCKED:")) return;
  try {
    const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
    await handle.signal(guardrailBlockedSignal, {
      agentShortId: state.agent.shortId,
      blockedAction: execResult.error.replace(/^BLOCKED:\s*/, "").split(" is ")[0],
      reason: execResult.error,
    });
  } catch {
    // Orchestrator may have already completed
  }
}

// Re-export for convenience within the workflow sandbox
export type { AgentWorkflowInput } from "./types.js";

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function agentWorkflow(input: AgentWorkflowInput): Promise<void> {
  const state = createAgentState(input.agent);
  let directoryReceived = false;

  // ── Signal handlers (fill the mailboxes) ─────────────────────────────────
  setHandler(directiveSignal, (directive) => {
    handleDirective(state, directive);
  });

  setHandler(peerMessageSignal, (message) => {
    handlePeerMessage(state, message);
  });

  setHandler(agentBroadcastSignal, (broadcast) => {
    handleBroadcast(state, broadcast);
  });

  setHandler(subConvMessageSignal, (message) => {
    handleSubConvMessage(state, message);
  });

  setHandler(agentDirectorySignal, (directory) => {
    handleAgentDirectory(state, directory);
    directoryReceived = true;
  });

  setHandler(pluginDisconnectedSignal, () => {
    handlePluginDisconnected(state);
  });

  setHandler(subConvInviteSignal, async (invite) => {
    const effect = handleSubConvInvite(state, invite);
    if (effect) {
      await executeEffect(state, effect, input.userId);
    }
  });

  setHandler(subConvCloseSignal, (close) => {
    handleSubConvClose(state, close);
  });

  // ── Wait for directory ───────────────────────────────────────────────────
  await condition(() => directoryReceived);

  // ── Inject system prompt ─────────────────────────────────────────────────
  const peerAgents = Array.from(state.agentDirectory.values());
  const systemPrompt = buildAgentSystemPrompt(
    input.agent,
    "orchestrator",
    peerAgents
  );
  state.messageHistory.push({
    role: "system",
    content: systemPrompt,
  });

  // ── Main loop ────────────────────────────────────────────────────────────
  while (!state.completed && !state.disconnected) {
    // Wait for any input
    const hasInput = () =>
      state.directiveQueue.length > 0 ||
      state.peerMessageQueue.length > 0 ||
      state.broadcastQueue.length > 0 ||
      state.subConvMessageQueue.length > 0 ||
      state.disconnected;

    await condition(hasInput);

    // Process queued inputs
    const effects = processQueues(state);

    for (const effect of effects) {
      if (effect.type === "call_llm") {
        // LLM loop
        const llmResult = await callLLM({
          messages: effect.messages,
          tools: effect.tools,
          userId: input.userId,
          model: input.model,
        });

        const responseEffects = processLLMResponse(
          state,
          llmResult.content,
          llmResult.toolCalls
        );

        // Execute tool effects first, then LLM continuation
        let didExecTool = false;
        let pendingLLM: { messages: typeof effect.messages; tools: typeof effect.tools } | null = null;

        // Collect all figma tool call IDs in order, then match them to execute effects
        const figmaToolNames = new Set(["figma_plugin_execute", "figma_confirm_execute"]);
        const figmaToolCallIds = state.messageHistory
          .flatMap((m) => m.toolCalls ?? [])
          .filter((tc) => figmaToolNames.has(tc.name))
          .map((tc) => tc.id);
        let figmaToolCallIdx = 0;

        const mainPendingCodeExecuted: import("@guardian/orchestrations").AgentActivity[] = [];

        for (const rEffect of responseEffects) {
          if (rEffect.type === "execute_figma_code") {
            const execResult = await executeFigmaCode({
              pluginClientId: rEffect.pluginClientId || input.agent.pluginClientId || "",
              userId: input.userId,
              code: rEffect.code,
              workflowId: state.orchestratorWorkflowId,
            });

            mainPendingCodeExecuted.push({
              action: "code_executed" as const,
              success: execResult.success ?? false,
              summary: execResult.success
                ? `OK${execResult.result ? `: ${String(execResult.result).slice(0, 200)}` : ""}`
                : (execResult.error?.slice(0, 200) ?? "Execution failed"),
            });
            await notifyGuardrailIfBlocked(execResult, state);

            const toolCallId = figmaToolCallIds[figmaToolCallIdx++];
            if (toolCallId) {
              injectToolResult(state, toolCallId, JSON.stringify(execResult));
            }
            didExecTool = true;
          } else if (rEffect.type === "emit_activity") {
            const merged = mainPendingCodeExecuted.length > 0
              ? { ...rEffect, activities: [...mainPendingCodeExecuted.splice(0), ...rEffect.activities] }
              : rEffect;
            await executeEffect(state, merged, input.userId);
          } else if (rEffect.type === "call_llm") {
            pendingLLM = { messages: rEffect.messages, tools: rEffect.tools };
          } else {
            await executeEffect(state, rEffect, input.userId);
          }
        }

        if (mainPendingCodeExecuted.length > 0) {
          await executeEffect(state, { type: "emit_activity", activities: mainPendingCodeExecuted }, input.userId);
        }

        // Continue LLM loop with correct messages (including tool results)
        if (pendingLLM) {
          const msgs = didExecTool ? [...state.messageHistory] : pendingLLM.messages;
          await executeLLMLoop(state, msgs, pendingLLM.tools, input.userId, input.model);
        }
      } else if (effect.type === "wait_for_input") {
        // Continue to next loop iteration
        continue;
      } else {
        await executeEffect(state, effect, input.userId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LLM tool-call loop
// ---------------------------------------------------------------------------

async function executeLLMLoop(
  state: AgentWorkflowState,
  messages: LLMMessage[],
  tools: Parameters<typeof callLLM>[0]["tools"],
  userId: string,
  model?: string
): Promise<void> {
  let maxIterations = 20;

  while (maxIterations-- > 0 && !state.completed) {
    const llmResult = await callLLM({ messages, tools, userId, model });
    const effects = processLLMResponse(state, llmResult.content, llmResult.toolCalls);

    let needsContinue = false;
    let didExecuteTool = false;

    // Collect figma tool call IDs for sequential matching
    const loopFigmaNames = new Set(["figma_plugin_execute", "figma_confirm_execute"]);
    const loopFigmaIds = state.messageHistory
      .flatMap((m) => m.toolCalls ?? [])
      .filter((tc) => loopFigmaNames.has(tc.name))
      .map((tc) => tc.id);
    let loopFigmaIdx = 0;

    // Collect code_executed results to inject into the emit_activity effect
    const pendingCodeExecutedActivities: import("@guardian/orchestrations").AgentActivity[] = [];

    for (const effect of effects) {
      if (effect.type === "execute_figma_code") {
        const execResult = await executeFigmaCode({
          pluginClientId: effect.pluginClientId || state.agent.pluginClientId || "",
          userId,
          code: effect.code,
          workflowId: state.orchestratorWorkflowId,
        });

        // Store code_executed to inject into the next emit_activity batch
        pendingCodeExecutedActivities.push({
          action: "code_executed" as const,
          success: execResult.success ?? false,
          summary: execResult.success
            ? `OK${execResult.result ? `: ${String(execResult.result).slice(0, 200)}` : ""}`
            : (execResult.error?.slice(0, 200) ?? "Execution failed"),
        });
        await notifyGuardrailIfBlocked(execResult, state);

        const toolCallId = loopFigmaIds[loopFigmaIdx++];
        if (toolCallId) {
          injectToolResult(state, toolCallId, JSON.stringify(execResult));
        }

        didExecuteTool = true;
        needsContinue = true;
      } else if (effect.type === "emit_activity") {
        // Inject any pending code_executed results into this batch
        const merged = pendingCodeExecutedActivities.length > 0
          ? { ...effect, activities: [...pendingCodeExecutedActivities.splice(0), ...effect.activities] }
          : effect;
        await executeEffect(state, merged, userId);
      } else if (effect.type === "call_llm") {
        if (!didExecuteTool) {
          messages = effect.messages;
        } else {
          messages = [...state.messageHistory];
        }
        tools = effect.tools;
        needsContinue = true;
      } else {
        await executeEffect(state, effect, userId);
      }
    }

    // If code_executed wasn't injected (no emit_activity in this batch), emit separately
    if (pendingCodeExecutedActivities.length > 0) {
      await executeEffect(state, { type: "emit_activity", activities: pendingCodeExecutedActivities }, userId);
    }

    // If tools were executed but no call_llm effect, still continue
    if (didExecuteTool && !needsContinue) {
      messages = [...state.messageHistory];
      needsContinue = true;
    }

    if (!needsContinue) break;
  }
}

// ---------------------------------------------------------------------------
// Effect executor
// ---------------------------------------------------------------------------

async function executeEffect(
  state: AgentWorkflowState,
  effect: AgentEffect,
  userId: string
): Promise<void> {
  switch (effect.type) {
    case "report_to_orchestrator": {
      try {
        const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
        await handle.signal(agentReportSignal, effect.report);
      } catch {
        // Orchestrator may have already completed
      }
      break;
    }

    case "send_peer_message": {
      try {
        const handle = getExternalWorkflowHandle(effect.targetWorkflowId);
        await handle.signal(peerMessageSignal, effect.message);
      } catch {
        // Peer workflow may have already completed
      }
      break;
    }

    case "send_broadcast": {
      try {
        const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
        await handle.signal(agentReportSignal, {
          agentShortId: state.agent.shortId,
          status: "in_progress",
          summary: `[Broadcast] ${effect.broadcast.content}`,
        });
      } catch {
        // Orchestrator may have already completed
      }
      break;
    }

    case "send_sub_conv_invite": {
      for (const wid of effect.targetWorkflowIds) {
        try {
          const handle = getExternalWorkflowHandle(wid);
          await handle.signal(subConvInviteSignal, effect.invite);
        } catch {
          // Target may have already completed
        }
      }
      break;
    }

    case "send_sub_conv_response": {
      try {
        const handle = getExternalWorkflowHandle(effect.targetWorkflowId);
        await handle.signal(subConvResponseSignal, effect.response);
      } catch {
        // Target may have already completed
      }
      break;
    }

    case "send_sub_conv_message": {
      for (const wid of effect.targetWorkflowIds) {
        try {
          const handle = getExternalWorkflowHandle(wid);
          await handle.signal(subConvMessageSignal, effect.message);
        } catch {
          // Target may have already completed
        }
      }
      break;
    }

    case "send_sub_conv_close": {
      for (const wid of effect.targetWorkflowIds) {
        try {
          const handle = getExternalWorkflowHandle(wid);
          await handle.signal(subConvCloseSignal, effect.close);
        } catch {
          // Target may have already completed
        }
      }
      break;
    }

    case "notify_orchestrator_sub_conv": {
      try {
        const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
        await handle.signal(subConvNotifySignal, {
          subConvId: effect.subConvId,
          event: effect.event,
          participantIds: effect.participantIds,
          topic: effect.topic,
          reason: effect.reason,
        });
      } catch {
        // Orchestrator may have already completed
      }
      break;
    }

    case "emit_activity": {
      try {
        const handle = getExternalWorkflowHandle(state.orchestratorWorkflowId);
        await handle.signal(agentActivitySignal, {
          agentShortId: state.agent.shortId,
          activities: effect.activities,
        });
      } catch {
        // Orchestrator may have already completed
      }
      break;
    }

    case "complete":
      // Workflow will naturally exit the loop
      break;

    case "wait_for_input":
      // No-op, handled by the main loop
      break;

    default:
      break;
  }
}
