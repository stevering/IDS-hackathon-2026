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
  generateBriefAndFirstCall,
  processOrchestratorLLMResponse,
  getOrchestratorTools,
  processReports,
  processUserInput,
  checkCompletion,
  cleanupIdleAgents,
  handleCancellation,
  handleBroadcastRelay,
  processGuardrailBlocked,
  processAgentActivities,
  getAgentViewStates,
  getEventsSince,
  IDLE_NUDGE_MS,
  GRACE_PERIOD_MS,
  type OrchestratorState,
  type OrchestratorEffect,
} from "@guardian/orchestrations";

import type {
  StartOrchestrationParams,
  OrchestrationResult,
  AgentId,
  LLMToolDefinition,
  LLMMessage,
} from "@guardian/orchestrations";

import {
  agentReportSignal,
  userInputSignal,
  subConvNotifySignal,
  broadcastSignal,
  stopSignal,
  guardrailBlockedSignal,
  agentActivitySignal,
  statusQuery,
  directiveSignal,
  terminateAgentSignal,
  agentDirectorySignal,
  agentBroadcastSignal,
} from "../signals/definitions.js";

import type { LLMActivities, PersistenceActivities, StreamingLLMActivities } from "../activities/types.js";

import { agentWorkflow } from "./agent.js";

// Proxy activities — normal timeouts
const normalLLM = proxyActivities<LLMActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});
// Proxy activities — slow delegation mode
const slowLLM = proxyActivities<LLMActivities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
});
// Streaming LLM proxy — for token-by-token streaming via Realtime
// (available for future use when orchestration UI supports streaming)
const _streamingLLM = proxyActivities<StreamingLLMActivities>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 2 },
});

const { saveOrchestrationState, persistDurableEvents } = proxyActivities<PersistenceActivities>({
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

  // ── Durable event flush tracking ─────────────────────────────────────────
  let lastFlushedIndex = 0;

  /** Flush new durable events since last flush (micro-batch). */
  async function flushDurableEvents() {
    const newEvents = state.eventLog.slice(lastFlushedIndex);
    lastFlushedIndex = state.eventLog.length;
    if (newEvents.length === 0) return;
    await persistDurableEvents({
      workflowId: orchestratorWorkflowId,
      events: newEvents as Array<Record<string, unknown>>,
      userId: params.userId,
    });
  }

  // Choose activity proxy and idle nudge based on slow delegation mode
  const userSettings = (params.context as Record<string, unknown>)?.userSettings as Record<string, unknown> | undefined;
  const devSlowDelegation = !!(userSettings?.devSlowDelegation);
  const { callLLM } = devSlowDelegation ? slowLLM : normalLLM;
  const idleNudgeMs = devSlowDelegation ? 5 * 60_000 : IDLE_NUDGE_MS;

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

  setHandler(guardrailBlockedSignal, (payload) => {
    state.pendingGuardrails.push(payload);
  });

  setHandler(agentActivitySignal, (payload) => {
    state.pendingActivities.push(payload);
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
  setHandler(statusQuery, (sinceIndex?: number) => {
    const elapsed = Date.now() - state.startedAt;
    const remaining = Math.max(0, state.maxDurationMs - elapsed);
    const { events, cursor } = getEventsSince(state, sinceIndex ?? 0);

    return {
      orchestrationId: state.orchestrationId,
      status: state.status,
      agents: getAgentViewStates(state),
      events,
      eventCursor: cursor,
      timerRemainingMs: state.status === "active" ? remaining : null,
      totalDurationMs: state.maxDurationMs,
    };
  });

  // Tracks uncaught errors from any phase so the Final save block can emit
  // `orchestration_completed` with `status:"failed"` instead of letting the
  // workflow die silently (which leaves the UI stuck on `isActive:true`).
  let uncaughtError: string | null = null;

  try {

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
          model: params.agentModel ?? params.model,
          mcpServerIds: params.mcpServerIds,
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

  // Emit orchestration_started event so the SSE stream knows about agents
  state.eventLog.push({
    type: "orchestration_started",
    orchestrationId: state.orchestrationId,
    agents: getAgentViewStates(state),
  });

  // ── Phase 2: Send directory to all agents ────────────────────────────────
  const directoryEffects = generateDirectoryEffects(state, orchestratorWorkflowId);
  for (const effect of directoryEffects) {
    if (effect.type === "send_directory") {
      const handle = getExternalWorkflowHandle(effect.agentWorkflowId);
      await handle.signal(agentDirectorySignal, effect.directory);
    }
  }

  // ── Phase 2b: Watch for child workflow crashes ──────────────────────────
  // If an agent workflow fails unexpectedly (LLM error, activity crash, etc.),
  // inject a "failed" report so the orchestrator loop can react instead of
  // hanging forever waiting for a signal that will never come.
  for (const [shortId, agentState] of state.agents) {
    if (agentState.workflowHandle) {
      // Cast to ChildWorkflowHandle — the engine types it as `unknown`
      // but Temporal's startChild returns a handle with .result()
      const handle = agentState.workflowHandle as { result: () => Promise<unknown> };
      const agentShortId = shortId;
      // Fire-and-forget: monitor the child workflow result in the background
      handle.result().catch((err: Error) => {
        // Only inject if agent isn't already marked as done
        const current = state.agents.get(agentShortId);
        if (current && current.status === "active") {
          const errorMsg = err.message || String(err);
          current.status = "failed";
          state.pendingReports.push({
            agentShortId,
            status: "failed",
            summary: `Agent workflow crashed: ${errorMsg.slice(0, 500)}`,
          });
          state.eventLog.push({
            type: "agent_status_changed",
            agentShortId,
            status: "failed",
          });
        }
      });
    }
  }

  // ── Phase 3: System brief + orchestrator tool-based planning ────────────
  //
  // 1. System injects context into orchestrator history (deterministic)
  // 2. Agents already have task context in their system prompt (deterministic)
  // 3. Orchestrator LLM is called with tools — it decides directives itself
  //
  const briefEffects = generateBriefAndFirstCall(state);
  const briefNonLLM = briefEffects.filter((e) => e.type !== "call_llm");
  const briefLLM = briefEffects.find((e) => e.type === "call_llm");
  await executeEffects(state, briefNonLLM, params.userId);

  if (briefLLM && briefLLM.type === "call_llm") {
    await executeOrchestratorLLMLoop(
      state,
      briefLLM.messages,
      briefLLM.tools ?? getOrchestratorTools(state),
      params,
      callLLM
    );
  }

  // Flush durable events from phases 1-3 (started, brief, initial directives)
  await flushDurableEvents();

  // ── Phase 4: Coordination loop ──────────────────────────────────────────
  while (state.status === "active" && !cancelled) {
    // Wait for signals or timeout
    const hasWork = () =>
      state.pendingReports.length > 0 ||
      state.userInputQueue.length > 0 ||
      state.pendingGuardrails.length > 0 ||
      state.pendingActivities.length > 0 ||
      cancelled;

    await condition(hasWork, idleNudgeMs);

    // Check cancellation
    if (cancelled) {
      const cancelEffects = handleCancellation(state);
      await executeEffects(state, cancelEffects, params.userId);
      break;
    }

    // Process agent activities first (emit-only) — must appear before reports in the timeline
    if (state.pendingActivities.length > 0) {
      const activityEffects = processAgentActivities(state);
      await executeEffects(state, activityEffects, params.userId);
    }

    // Process guardrail blocked notifications (emit-only)
    if (state.pendingGuardrails.length > 0) {
      const guardrailEffects = processGuardrailBlocked(state);
      await executeEffects(state, guardrailEffects, params.userId);
    }

    // Process reports (triggers orchestrator LLM with tools)
    if (state.pendingReports.length > 0) {
      const reportEffects = processReports(state);
      for (const effect of reportEffects) {
        if (effect.type === "call_llm") {
          await executeOrchestratorLLMLoop(
            state,
            effect.messages,
            effect.tools ?? getOrchestratorTools(state),
            params,
            callLLM
          );
        }
      }
      // Execute non-LLM effects (emit_event, etc.)
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
          await executeOrchestratorLLMLoop(
            state,
            effect.messages,
            effect.tools ?? getOrchestratorTools(state),
            params,
            callLLM
          );
        }
      }
    }

    // Flush any activities that arrived during report processing / LLM calls
    if (state.pendingActivities.length > 0) {
      const midActivities = processAgentActivities(state);
      await executeEffects(state, midActivities, params.userId);
    }

    // Flush durable events from this iteration (directives, reports, etc.)
    await flushDurableEvents();

    // Auto-finalize idle agents (e.g. a Designer that was never asked to review)
    // before checking completion, so a forgotten cleanup doesn't keep the
    // orchestration Running until timeout.
    const cleanupEffects = cleanupIdleAgents(state);
    if (cleanupEffects.length > 0) {
      await executeEffects(state, cleanupEffects, params.userId);
    }

    // Check completion
    const completionEffect = checkCompletion(state);
    if (completionEffect) {
      if (completionEffect.type === "complete") {
        // Grace period — wait for trailing signals from agents
        await sleep(GRACE_PERIOD_MS);

        // Check again — new reports may have arrived during grace
        if (state.pendingReports.length > 0) {
          continue;
        }

        // Final drain: wait for any trailing agent activity signals.
        for (let drain = 0; drain < 3; drain++) {
          await condition(
            () => state.pendingActivities.length > 0 || state.pendingGuardrails.length > 0,
            2000
          );

          if (state.pendingActivities.length > 0) {
            const finalActivities = processAgentActivities(state);
            await executeEffects(state, finalActivities, params.userId);
          }
          if (state.pendingGuardrails.length > 0) {
            const finalGuardrails = processGuardrailBlocked(state);
            await executeEffects(state, finalGuardrails, params.userId);
          }

          if (state.pendingReports.length > 0) {
            break;
          }
        }

        // Fall through to final save below
        break;
      }
    }
  }

  } catch (err) {
    // Unwrap Temporal's ActivityFailure to surface the root cause
    let rootMessage = err instanceof Error ? err.message : String(err);
    let current: unknown = err;
    while (current instanceof Error && current.cause) {
      current = current.cause;
      if (current instanceof Error && current.message) {
        rootMessage = current.message;
      }
    }
    uncaughtError = rootMessage;
    state.status = "failed";
    for (const agentState of state.agents.values()) {
      if (agentState.status === "active") agentState.status = "failed";
    }
  }

  // ── Final save ──────────────────────────────────────────────────────────
  // Reached when: completion break, while exit (status !== active), cancellation, or uncaught error.
  const result: OrchestrationResult = {
    status: state.status === "active" ? "cancelled" : state.status as OrchestrationResult["status"],
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

  state.eventLog.push({
    type: "orchestration_completed",
    status: result.status,
    ...(uncaughtError ? { error: uncaughtError } : {}),
  });

  await flushDurableEvents();

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
// Orchestrator LLM tool-call loop
// ---------------------------------------------------------------------------

async function executeOrchestratorLLMLoop(
  state: OrchestratorState,
  messages: LLMMessage[],
  tools: LLMToolDefinition[],
  params: { userId: string; model?: string },
  callLLM: LLMActivities["callLLM"]
): Promise<void> {
  let currentMessages = messages;
  let currentTools = tools;
  let maxIterations = 10;

  while (maxIterations-- > 0) {
    const loopUserSettings = (state.context as Record<string, unknown>)?.userSettings as Record<string, unknown> | undefined;
    const llmResult = await callLLM({
      messages: currentMessages,
      tools: currentTools,
      userId: params.userId,
      model: params.model,
      purpose: "orchestrator",
      tracing: {
        conversationType: "orchestration",
        orchestrationId: state.orchestrationId,
        devLLMDelegation: !!(loopUserSettings?.devLLMDelegation),
        devSlowDelegation: !!(loopUserSettings?.devSlowDelegation),
      },
    });

    // Update metadata format from LLM result (resolved per model config)
    if (llmResult.metadataFormat) state.metadataFormat = llmResult.metadataFormat;
    if (llmResult.modelId) state.model = llmResult.modelId;

    const effects = processOrchestratorLLMResponse(
      state,
      llmResult.content,
      llmResult.toolCalls,
      llmResult.reasoning,
      llmResult.usage,
      llmResult.intercepted,
      llmResult.reasoningSimulated,
      llmResult.modelId
    );

    // Separate continuation call_llm from other effects
    const nonLLM = effects.filter((e) => e.type !== "call_llm");
    const continuation = effects.find((e) => e.type === "call_llm");

    await executeEffects(state, nonLLM, params.userId);

    if (continuation && continuation.type === "call_llm") {
      currentMessages = continuation.messages;
      currentTools = continuation.tools ?? currentTools;
    } else {
      break;
    }
  }
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

      case "terminate_agent": {
        try {
          const handle = getExternalWorkflowHandle(effect.agentWorkflowId);
          await handle.signal(terminateAgentSignal);
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
