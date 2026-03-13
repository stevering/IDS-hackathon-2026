/**
 * Orchestrator Temporal workflow.
 *
 * Thin adapter that wraps the engine-agnostic orchestrator logic
 * with Temporal-specific APIs (signals, queries, child workflows,
 * activities, timers).
 */

import {
  condition,
  startChild,
  getExternalWorkflowHandle,
  sleep,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";

import {
  createOrchestratorState,
  generateStartEffects,
  generateDirectoryEffects,
  generatePlanningCall,
  processPlanningResponse,
  processReports,
  processCoordinationResponse,
  processUserInput,
  checkCompletion,
  handleCancellation,
  handleBroadcastRelay,
  getAgentViewStates,
  drainEvents,
  IDLE_NUDGE_MS,
  GRACE_PERIOD_MS,
  type OrchestratorState,
  type OrchestratorEffect,
} from "@guardian/orchestrations";

import type {
  StartOrchestrationParams,
  OrchestrationResult,
  AgentId,
} from "@guardian/orchestrations";

import {
  agentReportSignal,
  userInputSignal,
  subConvNotifySignal,
  broadcastSignal,
  stopSignal,
  statusQuery,
  directiveSignal,
  agentDirectorySignal,
  agentBroadcastSignal,
} from "../signals/definitions.js";

import type { LLMActivities, PersistenceActivities } from "../activities/types.js";

import { agentWorkflow } from "./agent.js";

// Proxy activities
const { callLLM } = proxyActivities<LLMActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

const { saveOrchestrationState } = proxyActivities<PersistenceActivities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 2 },
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function orchestratorWorkflow(
  params: StartOrchestrationParams
): Promise<OrchestrationResult> {
  const state = createOrchestratorState(params);
  const orchestratorWorkflowId = workflowInfo().workflowId;
  let cancelled = false;

  // ── Signal handlers ──────────────────────────────────────────────────────
  setHandler(agentReportSignal, (report) => {
    state.pendingReports.push(report);
  });

  setHandler(userInputSignal, (input) => {
    state.userInputQueue.push(input);
  });

  setHandler(subConvNotifySignal, (notification) => {
    state.subConvNotifications.push(notification);
  });

  setHandler(broadcastSignal, (broadcast) => {
    const effects = handleBroadcastRelay(state, broadcast);
    // Fire-and-forget relay (executed in next loop iteration context)
    for (const effect of effects) {
      if (effect.type === "broadcast_to_agents") {
        relayBroadcast(state, effect.excludeShortIds, effect.content, effect.fromAgentId);
      }
    }
  });

  setHandler(stopSignal, () => {
    cancelled = true;
  });

  // ── Query handler ────────────────────────────────────────────────────────
  setHandler(statusQuery, () => {
    const elapsed = Date.now() - state.startedAt;
    const remaining = Math.max(0, state.maxDurationMs - elapsed);

    return {
      orchestrationId: state.orchestrationId,
      status: state.status,
      agents: getAgentViewStates(state),
      events: drainEvents(state),
      timerRemainingMs: state.status === "active" ? remaining : null,
      totalDurationMs: state.maxDurationMs,
    };
  });

  // ── Phase 1: Start agent child workflows ─────────────────────────────────
  const startEffects = generateStartEffects(state);
  for (const effect of startEffects) {
    if (effect.type === "start_agent") {
      const childWorkflowId = `${state.orchestrationId}-agent-${effect.agent.shortId}`;
      const handle = await startChild(agentWorkflow, {
        workflowId: childWorkflowId,
        args: [{
          agent: effect.agent,
          task: effect.task,
          context: effect.context,
          userId: params.userId,
        }],
        taskQueue: workflowInfo().taskQueue,
      });

      // Update agent with its workflow ID
      const agentState = state.agents.get(effect.agent.shortId);
      if (agentState) {
        agentState.agent.workflowId = childWorkflowId;
        agentState.workflowHandle = handle;
        agentState.status = "active";
      }
    }
  }

  // ── Phase 2: Send directory to all agents ────────────────────────────────
  const directoryEffects = generateDirectoryEffects(state, orchestratorWorkflowId);
  for (const effect of directoryEffects) {
    if (effect.type === "send_directory") {
      const handle = getExternalWorkflowHandle(effect.agentWorkflowId);
      await handle.signal(agentDirectorySignal, effect.directory);
    }
  }

  // ── Phase 3: LLM planning ───────────────────────────────────────────────
  const planningCall = generatePlanningCall(state);
  if (planningCall.type === "call_llm") {
    const llmResult = await callLLM({
      messages: planningCall.messages,
      userId: params.userId,
    });

    const directiveEffects = processPlanningResponse(state, llmResult.content);
    await executeEffects(state, directiveEffects, params.userId);
  }

  // ── Phase 4: Coordination loop ──────────────────────────────────────────
  while (state.status === "active" && !cancelled) {
    // Wait for signals or timeout
    const hasWork = () =>
      state.pendingReports.length > 0 ||
      state.userInputQueue.length > 0 ||
      cancelled;

    await condition(hasWork, IDLE_NUDGE_MS);

    // Check cancellation
    if (cancelled) {
      const cancelEffects = handleCancellation(state);
      await executeEffects(state, cancelEffects, params.userId);
      break;
    }

    // Process reports
    if (state.pendingReports.length > 0) {
      const reportEffects = processReports(state);
      for (const effect of reportEffects) {
        if (effect.type === "call_llm") {
          const llmResult = await callLLM({
            messages: effect.messages,
            userId: params.userId,
          });

          const coordEffects = processCoordinationResponse(state, llmResult.content);
          await executeEffects(state, coordEffects, params.userId);
        }
      }
      // Re-emit non-LLM effects
      await executeEffects(
        state,
        reportEffects.filter((e) => e.type !== "call_llm"),
        params.userId
      );
    }

    // Process user input
    if (state.userInputQueue.length > 0) {
      const inputEffects = processUserInput(state);
      for (const effect of inputEffects) {
        if (effect.type === "call_llm") {
          const llmResult = await callLLM({
            messages: effect.messages,
            userId: params.userId,
          });

          const coordEffects = processCoordinationResponse(state, llmResult.content);
          await executeEffects(state, coordEffects, params.userId);
        }
      }
    }

    // Check completion
    const completionEffect = checkCompletion(state);
    if (completionEffect) {
      if (completionEffect.type === "complete") {
        // Grace period before final completion
        await sleep(GRACE_PERIOD_MS);

        // Check again — new reports may have arrived during grace
        if (state.pendingReports.length > 0) {
          continue;
        }

        await saveOrchestrationState({
          orchestrationId: state.orchestrationId,
          status: completionEffect.result.status,
          agentResults: completionEffect.result.agentResults,
          durationMs: completionEffect.result.durationMs,
          userId: params.userId,
        });

        state.eventLog.push({
          type: "orchestration_completed",
          status: completionEffect.result.status,
        });

        return completionEffect.result;
      }
    }
  }

  // Final save
  const result: OrchestrationResult = {
    status: state.status === "active" ? "cancelled" : state.status,
    agentResults: Object.fromEntries(
      Array.from(state.agents.entries()).map(([id, a]) => [
        id,
        {
          status: a.lastReport?.status ?? "interrupted",
          summary: a.lastReport?.summary,
          changes: a.lastReport?.changes,
        },
      ])
    ),
    durationMs: Date.now() - state.startedAt,
  };

  await saveOrchestrationState({
    orchestrationId: state.orchestrationId,
    status: result.status,
    agentResults: result.agentResults,
    durationMs: result.durationMs,
    userId: params.userId,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Effect executor
// ---------------------------------------------------------------------------

async function executeEffects(
  state: OrchestratorState,
  effects: OrchestratorEffect[],
  userId: string
): Promise<void> {
  for (const effect of effects) {
    switch (effect.type) {
      case "send_directive": {
        try {
          const handle = getExternalWorkflowHandle(effect.agentWorkflowId);
          await handle.signal(directiveSignal, effect.directive);
        } catch {
          // Agent workflow may have already completed
        }
        break;
      }

      case "broadcast_to_agents": {
        await relayBroadcast(state, effect.excludeShortIds, effect.content, effect.fromAgentId);
        break;
      }

      case "cancel_agent": {
        try {
          const handle = getExternalWorkflowHandle(effect.agentWorkflowId);
          await handle.cancel();
        } catch {
          // Agent workflow may have already completed
        }
        break;
      }

      case "emit_event": {
        // Events are already pushed to state.eventLog by the logic layer
        break;
      }

      case "save_state": {
        await saveOrchestrationState({
          orchestrationId: state.orchestrationId,
          status: state.status,
          agentResults: {},
          durationMs: Date.now() - state.startedAt,
          userId,
        });
        break;
      }

      // "call_llm" and "complete" handled at the call site
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Broadcast helper
// ---------------------------------------------------------------------------

async function relayBroadcast(
  state: OrchestratorState,
  excludeShortIds: string[],
  content: string,
  fromAgentId: string
): Promise<void> {
  const excludeSet = new Set(excludeShortIds);

  for (const [shortId, agentState] of state.agents) {
    if (excludeSet.has(shortId) || agentState.status !== "active" || !agentState.agent.workflowId) {
      continue;
    }

    try {
      const handle = getExternalWorkflowHandle(agentState.agent.workflowId);
      await handle.signal(agentBroadcastSignal, { fromAgentId, content });
    } catch {
      // Agent workflow may have already completed — mark it
      agentState.status = "completed";
    }
  }
}
