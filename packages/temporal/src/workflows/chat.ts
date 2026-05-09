/**
 * Chat Temporal workflow.
 *
 * Handles a single chat conversation with durable execution:
 *   - Survives browser tab closure
 *   - Token-by-token streaming via Supabase Realtime sidecar
 *   - MCP tool execution server-side
 *   - Figma code execution via plugin bridge
 *   - Multi-turn: stays alive between messages (IDLE timeout)
 *
 * State machine:
 *   INIT → LOAD_HISTORY → [LLM_CALL → TOOL_EXECUTION]* → PERSIST → IDLE
 *                                                                     ↓
 *                                                       (new message signal)
 *                                                                     ↓
 *                                                            LLM_CALL → ...
 */

import {
  CancellationScope,
  condition,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
  sleep,
} from "@temporalio/workflow";

import type {
  LLMCallResult,
  LLMToolDefinition,
  LLMMessage,
} from "@guardian/orchestrations";

import {
  selectToolGroups,
  filterToolsByGroups,
  buildToolGroupPrompt,
  TOOL_GROUPS,
} from "@guardian/orchestrations";

import {
  chatNewMessageSignal,
  chatCancelSignal,
  chatStatusQuery,
  chatConversationIdQuery,
  type ChatNewMessagePayload,
  type ChatWorkflowStatus,
} from "../signals/definitions.js";

import type {
  StreamingLLMActivities,
  ChatPersistenceActivities,
  ChatBroadcastActivities,
  FigmaActivities,
  MCPActivities,
  MCPV2Activities,
  GuardianMetaActivities,
  InstanceManifestEntry,
} from "../activities/types.js";

// ---------------------------------------------------------------------------
// Activity proxies
// ---------------------------------------------------------------------------

const { callLLMStreaming } = proxyActivities<StreamingLLMActivities>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 1 }, // No auto-retry — errors shown to user immediately via stream_error
});

const { persistChatMessage, loadChatHistory } = proxyActivities<ChatPersistenceActivities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 2 },
});

const { broadcastChatEvent } = proxyActivities<ChatBroadcastActivities>({
  startToCloseTimeout: "5 seconds",
  retry: { maximumAttempts: 1 },
});

const { executeFigmaCode } = proxyActivities<FigmaActivities>({
  startToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 1 },
});

const { discoverMCPTools, executeMCPTool, pairFCCloudRelay } = proxyActivities<MCPActivities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 2 },
});

const { discoverMCPToolsV2, executeMCPToolV2 } = proxyActivities<MCPV2Activities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 2 },
});

const { executeGuardianMetaTool } = proxyActivities<GuardianMetaActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

// ---------------------------------------------------------------------------
// Workflow params
// ---------------------------------------------------------------------------

export type ChatWorkflowParams = {
  conversationId: string;
  userId: string;
  /** First user message to process */
  userMessage: string;
  /** Optional images attached to the first message */
  userImages?: string[];
  /** Model identifier (e.g. "xai/grok-3") */
  model?: string;
  /** System prompt */
  systemPrompt?: string;
  /** MCP server IDs to connect (legacy V1 path) */
  mcpServerIds?: string[];
  /** Figma plugin client ID (for figma_execute tool) */
  figmaPluginClientId?: string;
  /** V2: focus Design MCP instance ID (from TargetSelector) */
  focusDesignInstanceId?: string;
  /** V2: focus Code MCP instance ID (from TargetSelector) */
  focusCodeInstanceId?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STEPS = 20;
const IDLE_TIMEOUT_MS = 5 * 60_000; // 5 minutes waiting for next message

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function chatWorkflow(params: ChatWorkflowParams): Promise<void> {
  const workflowId = workflowInfo().workflowId;
  let status: ChatWorkflowStatus["status"] = "idle";
  let streamingRequestId: string | undefined;
  let currentStep = 0;
  let errorMessage: string | undefined;

  // Current effective model — starts as the one passed at workflow start, but
  // updated from every chatNewMessage signal's `modelOverride` so follow-up
  // messages honour the user's latest `user_settings.usage_source` / default
  // model choice. Without this, a workflow started in BYOK mode kept using the
  // old BYOK model even after the user switched to the included free tier.
  let currentModel: string | undefined = params.model;

  // Current effective Figma plugin clientId — mirror of `currentModel` for the
  // paired Figma plugin. Updated from every chatNewMessage signal's
  // `pluginClientIdOverride` so the user can switch the paired plugin
  // per-message (e.g. via the LLM's QCM disambiguation flow). Discovery is
  // still seeded with `params.figmaPluginClientId` (we don't re-discover MCP
  // tools mid-conversation), but tool execution uses `currentPluginClientId`.
  let currentPluginClientId: string | undefined = params.figmaPluginClientId;

  // Pending messages from signals
  const pendingMessages: ChatNewMessagePayload[] = [];

  // Cancellation plumbing.
  //
  // The chatCancelSignal is a "stop THIS turn" signal, not "destroy the whole
  // workflow" — the user must still be able to send a follow-up message after
  // clicking Stop without losing the conversation. We achieve this by wrapping
  // each LLM-loop turn in its own `CancellationScope.cancellable`: when the
  // signal fires, we cancel that scope, which cancels the in-flight activity
  // (callLLMStreaming → streamText is bound to ctx.cancellationSignal and
  // aborts immediately). The workflow itself catches the CancelledFailure,
  // resets state to idle, and keeps waiting for the next message.
  //
  // Without this, the `cancelled` flag was only checked at loop boundaries,
  // meaning a single LLM call could run for the full 5 minute startToClose
  // timeout before the cancel took effect — enough to burn 5 minutes of BYOK
  // tokens after the user thought they had stopped.
  let currentTurnScope: CancellationScope | null = null;

  // ── Signal handlers ─────────────────────────────────────────────────────
  setHandler(chatNewMessageSignal, (msg) => {
    if (msg.modelOverride) {
      currentModel = msg.modelOverride;
    }
    if (msg.pluginClientIdOverride !== undefined) {
      // null → unpair (REST-only mode), string → pair to that plugin.
      currentPluginClientId = msg.pluginClientIdOverride ?? undefined;
    }
    pendingMessages.push(msg);
  });

  setHandler(chatCancelSignal, () => {
    // Cancel only the in-flight turn's scope. The workflow stays alive so the
    // user can send a follow-up message without losing the conversation.
    if (currentTurnScope) {
      currentTurnScope.cancel();
    }
  });

  // ── Query handler ───────────────────────────────────────────────────────
  setHandler(chatStatusQuery, () => ({
    conversationId: params.conversationId,
    status,
    streamingRequestId,
    currentStep,
    errorMessage,
  }));

  // Defense-in-depth: the /api/chat-temporal/[id]/message route queries this
  // before signalling the workflow to ensure it matches the requested
  // conversationId. If mismatched, the route starts a fresh workflow for the
  // correct conversation instead of cross-contaminating.
  setHandler(chatConversationIdQuery, () => params.conversationId);

  // ── Workflow body, wrapped in a catch-all that broadcasts ──────────────
  // Any uncaught error below is broadcast to the client as a `workflow_error`
  // event on the Realtime channel BEFORE being re-thrown. Without this, a
  // workflow that crashed in an activity outside `callLLMStreaming` (e.g.
  // `loadChatHistory`, `persistChatMessage`, `executeMCPTool`) would leave
  // the client spinning forever because `useChatWorkflow` never learned
  // that the workflow was dead.
  try {
    await runChatWorkflowBody();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Skip the broadcast if this was a cancellation — the activity has
    // already broadcast a synthetic `text_complete` with finishReason=
    // "cancelled" and the workflow is returning to idle, not failing.
    if (!isCancellation(err)) {
      try {
        await broadcastChatEvent({
          conversationId: params.conversationId,
          event: "workflow_error",
          payload: { error: errMsg, status: "error" },
        });
      } catch { /* non-fatal */ }
      errorMessage = errMsg;
      status = "error";
    }
    throw err;
  }

  async function runChatWorkflowBody() {
  // ── Broadcast phase updates so the frontend shows accurate status ──────
  const broadcastPhase = async (phase: string) => {
    try {
      await broadcastChatEvent({
        conversationId: params.conversationId,
        event: "phase_update",
        payload: { phase },
      });
    } catch { /* non-fatal */ }
  };

  // ── Load conversation history ───────────────────────────────────────────
  await broadcastPhase("loading_history");
  const history = await loadChatHistory({
    conversationId: params.conversationId,
    userId: params.userId,
  });

  // Build LLM message array from DB history
  const messages: LLMMessage[] = [];
  if (params.systemPrompt) {
    messages.push({ role: "system", content: params.systemPrompt });
  }
  for (const msg of history) {
    if (msg.role === "system" || msg.role === "user" || msg.role === "assistant") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // ── Discover MCP tools ──────────────────────────────────────────────────
  await broadcastPhase("discovering_tools");
  // V2 path: instance-based, when focus IDs are provided by the TargetSelector.
  // V1 fallback: legacy mcpServerIds-based (during transition).
  let mcpTools: LLMToolDefinition[] = [];
  let instanceManifest: InstanceManifestEntry[] = [];
  const useV2 = !!(params.focusDesignInstanceId || params.focusCodeInstanceId);

  if (useV2) {
    try {
      const v2Result = await discoverMCPToolsV2({
        userId: params.userId,
        focusDesignInstanceId: params.focusDesignInstanceId,
        focusCodeInstanceId: params.focusCodeInstanceId,
      });
      mcpTools = v2Result.focusTools;
      instanceManifest = v2Result.instanceManifest;
    } catch {
      // Non-fatal: continue without MCP tools
    }
  } else {
    // Legacy V1: hardcoded server IDs
    const allMcpServerIds = ["guardian", ...(params.mcpServerIds ?? [])];
    try {
      mcpTools = await discoverMCPTools({
        userId: params.userId,
        mcpServerIds: allMcpServerIds,
        pluginClientId: params.figmaPluginClientId,
      });
    } catch {
      // Non-fatal
    }
  }

  // ── Auto-pair Figma Console (Southleft) cloud relay ──────────────────────
  // Southleft's figmaconsole_figma_execute write tools require the plugin to
  // be paired with their cloud relay via `figma_pair_plugin`. Without this,
  // every write tool call fails with "No plugin connected to cloud relay".
  // Pair once here (idempotent) so the LLM can use write tools immediately.
  const hasFigmaConsoleCloud = useV2
    ? instanceManifest.some((e) => e.presetType === "figma_console")
    : (params.mcpServerIds ?? []).includes("figma_console");
  if (hasFigmaConsoleCloud && params.figmaPluginClientId) {
    await broadcastPhase("connecting_figma");
    try {
      await pairFCCloudRelay({
        userId: params.userId,
        pluginClientId: params.figmaPluginClientId,
      });
    } catch {
      // Non-fatal: write tools may fail but read tools still work.
      // User will see "No plugin connected to cloud relay" error on first write.
    }
  }

  // ── V2: inject Guardian meta-tools + instance system prompt ──────────────
  // allFocusTools stores the unfiltered tool set for progressive disclosure
  // (guardian_load_tool_group). Declared here so the closure in runTurnBody can access it.
  let allFocusTools: LLMToolDefinition[] = [...mcpTools];

  if (useV2 && instanceManifest.length > 0) {
    // Add the 3 meta-tools to the catalog (always available)
    const metaSpecs: LLMToolDefinition[] = [
      { name: "guardian_list_instances", description: "List all MCP instances the user has configured and that are currently online.", parameters: { type: "object", properties: {}, required: [] } },
      { name: "guardian_get_instance_tools", description: "Get the list of tools exposed by a specific MCP instance (by label).", parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } },
      { name: "guardian_call_instance_tool", description: "Execute a tool on a non-focus MCP instance (by label).", parameters: { type: "object", properties: { label: { type: "string" }, tool_name: { type: "string" }, arguments: { type: "object" } }, required: ["label", "tool_name", "arguments"] } },
    ];
    mcpTools.push(...metaSpecs);

    // Add the 2 tool-group meta-tools (always available, even when no filtering)
    const toolGroupSpecs: LLMToolDefinition[] = [
      { name: "guardian_load_tool_group", description: "Load additional tools from a functional group into the current session. Call guardian_list_tool_groups first to see available groups.", parameters: { type: "object", properties: { group_id: { type: "string", description: "The group ID to load (e.g., 'figma_variables', 'code_editing')." } }, required: ["group_id"] } },
      { name: "guardian_list_tool_groups", description: "List all available tool groups with their descriptions. Use to discover which group to load.", parameters: { type: "object", properties: {}, required: [] } },
    ];
    mcpTools.push(...toolGroupSpecs);

    // ── Smart Tool Selection: pre-filter tools when over budget ────────────
    // Update allFocusTools now that meta-tools have been added.
    allFocusTools = [...mcpTools];
    const SMART_SELECTION_THRESHOLD = 40;
    let smartSelectionActive = false;
    let activeGroupIds: string[] = [];

    if (mcpTools.length > SMART_SELECTION_THRESHOLD) {
      // Extract the user message for scoring.
      const userMsg = params.userMessage ?? "";

      // Collect raw tool names from focus instances (strip prefix).
      const focusEntries = instanceManifest.filter((e) => e.isFocus);
      const rawToolNames = focusEntries.flatMap((e) => e.toolNames);

      const selection = selectToolGroups(userMsg, rawToolNames);
      activeGroupIds = selection.selectedGroupIds;

      // Filter focus-instance tools, keep non-focus tools (meta-tools, etc.) as-is.
      const focusPrefixes = focusEntries.map((e) => e.toolPrefix);
      const nonFocusTools = mcpTools.filter(
        (t) => !focusPrefixes.some((p) => t.name.startsWith(p)),
      );
      const filteredFocusTools: LLMToolDefinition[] = [];
      for (const entry of focusEntries) {
        const entryTools = mcpTools.filter((t) => t.name.startsWith(entry.toolPrefix));
        filteredFocusTools.push(
          ...filterToolsByGroups(entryTools, activeGroupIds, entry.toolPrefix),
        );
      }

      mcpTools = [...filteredFocusTools, ...nonFocusTools];
      smartSelectionActive = true;
    }

    // Inject the instance manifest into the system prompt.
    //
    // Guard: `messages` may be empty here if the caller passed no systemPrompt
    // AND history is empty (brand-new conversation started via a path that
    // doesn't set a system prompt — e.g., a misconfigured integration test).
    // Spreading `messages[0]` when it's undefined crashes the workflow at
    // boot. Instead, prepend a fresh system message when empty.
    const manifestBlock = buildManifestPrompt(instanceManifest);
    const toolGroupBlock = smartSelectionActive
      ? buildToolGroupPrompt(activeGroupIds, allFocusTools.length, mcpTools.length)
      : "";
    const fullBlock = [manifestBlock, toolGroupBlock].filter(Boolean).join("\n\n");
    if (fullBlock) {
      const first = messages[0];
      if (first && first.role === "system") {
        messages[0] = {
          ...first,
          content: (first.content ?? "") + "\n\n" + fullBlock,
        };
      } else {
        messages.unshift({ role: "system", content: fullBlock });
      }
    }

    // Surface discovery errors to the UI via a dedicated broadcast event.
    // The frontend listens to this and shows a dismissible warning banner.
    const failedInstances = instanceManifest.filter((i) => i.error);
    if (failedInstances.length > 0) {
      try {
        await broadcastChatEvent({
          conversationId: params.conversationId,
          event: "mcp_discovery_error",
          payload: {
            failures: failedInstances.map((i) => ({
              label: i.label,
              displayName: i.displayName ?? i.presetType,
              presetType: i.presetType,
              scope: i.scope,
              error: i.error ?? "Unknown error",
            })),
          },
        });
      } catch {
        // Non-fatal — continue without notification
      }
    }
  }

  // ── Process first message ───────────────────────────────────────────────
  // The user message was already persisted to DB by the HTTP route (via
  // save_message RPC) and loaded into `messages` by `loadChatHistory` above.
  // We only need to kick off the LLM loop — no need to add it again.
  await runLLMLoop();

  // ── Idle loop: wait for follow-up messages ──────────────────────────────
  // Note: chatCancelSignal does NOT break this loop — a cancel only stops the
  // current turn and returns us here. The only exits are:
  //   - idle timeout (5 min with no new message)
  //   - pendingMessages drained + idle timeout
  while (true) {
    status = "idle";
    streamingRequestId = undefined;
    currentStep = 0;

    const hasMessage = await condition(() => pendingMessages.length > 0, IDLE_TIMEOUT_MS);
    if (!hasMessage) break;

    const nextMsg = pendingMessages.shift()!;

    // User message was already persisted to DB by the /message route (via
    // save_message RPC) before the signal was sent. We only add it to the
    // in-memory array for the LLM call.
    messages.push({ role: "user", content: nextMsg.content, images: nextMsg.images });

    await runLLMLoop();
  }

  status = "completed";

  // ── Helper: LLM ↔ tool execution loop ──────────────────────────────────

  async function runLLMLoop() {
    status = "streaming";
    currentStep = 0;

    try {
      await CancellationScope.cancellable(async () => {
        currentTurnScope = CancellationScope.current();
        await runTurnBody();
      });
    } catch (err) {
      if (isCancellation(err)) {
        // User clicked Stop mid-turn. The in-flight activity has already
        // finalized its partial state (content so far + finishReason =
        // "cancelled") and the DB row is complete, so we just need to flip
        // back to idle so the outer loop can wait for the next message.
        status = "idle";
        streamingRequestId = undefined;
        return;
      }
      throw err;
    } finally {
      currentTurnScope = null;
    }
  }

  // Inner body — the same LLM ↔ tool loop as before, minus the cancellation
  // check (the surrounding CancellationScope handles that).
  async function runTurnBody() {
    while (currentStep < MAX_STEPS) {
      currentStep++;
      const requestId = `chat-${workflowId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      streamingRequestId = requestId;

      await broadcastPhase("waiting_for_model");
      let llmResult: LLMCallResult;
      try {
        llmResult = await callLLMStreaming({
          conversationId: params.conversationId,
          requestId,
          messages,
          tools: mcpTools.length > 0 ? mcpTools : undefined,
          model: currentModel,
          userId: params.userId,
        });
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        status = "error";
        // Error is broadcast via stream_error from the activity's catch block.
        // Don't persist as a chat message — the frontend shows it via the error banner.
        return;
      }

      // No tool calls → final response (already persisted by callLLMStreaming activity)
      if (!llmResult.toolCalls?.length) {
        messages.push({ role: "assistant", content: llmResult.content });
        // Message already persisted to DB by callLLMStreaming (pre-created + final update)
        status = "idle";
        return;
      }

      // Has tool calls → execute them
      status = "tool_executing";
      messages.push({
        role: "assistant",
        content: llmResult.content || "",
        toolCalls: llmResult.toolCalls,
      });

      for (const tc of llmResult.toolCalls) {
        let toolResult: string;
        let isError = false;

        // Notify browser: tool execution starting (non-fatal if broadcast fails)
        try {
          await broadcastChatEvent({
            conversationId: params.conversationId,
            event: "tool_call_start",
            payload: { toolName: tc.name, toolCallId: tc.id, args: tc.arguments },
          });
        } catch {
          // Broadcast failure is non-fatal — tool execution continues
        }

        try {
          if (tc.name === "guardian_figma_execute" || tc.name === "figma_plugin_execute") {
            if (!currentPluginClientId) {
              // Mirror the AMBIGUOUS_TARGET error returned by mcp.ts for
              // figma_console plugin-bound tools: the LLM must emit a QCM
              // before retrying. Without this branch the call would silently
              // fall through to the unknown-tool path and the LLM would never
              // learn it needs to disambiguate.
              const text =
                `AMBIGUOUS_TARGET: tool '${tc.name}' is plugin-bound but the user picked "Auto" ` +
                "with multiple Figma plugins connected. Look at the `DESIGN TARGET — DISAMBIGUATION REQUIRED` " +
                "section at the top of your system prompt: copy the QCM_START block from there VERBATIM as your " +
                "next response (with QCM_META JSON included). Do NOT call `guardian_list_instances` — the " +
                "candidate plugins are already listed in that section. Do NOT retry the tool until the user " +
                "picks — it will fail again with the same error.";
              toolResult = JSON.stringify({ content: [{ type: "text", text }], isError: true });
              isError = true;
            } else {
              // Figma code execution via plugin bridge (direct Supabase Realtime)
              const code = (tc.arguments.code as string) ?? "";
              const result = await executeFigmaCode({
                pluginClientId: currentPluginClientId,
                userId: params.userId,
                code,
                workflowId,
              });
              toolResult = result.success
                ? JSON.stringify(result.result ?? { success: true })
                : formatToolError(tc.name, result.error, { source: "Figma plugin" });
              isError = !result.success;
            }
          } else if (tc.name === "guardian_load_tool_group") {
            // Smart Tool Selection: dynamically load a tool group into the session.
            const groupId = (tc.arguments.group_id as string) ?? "";
            const group = TOOL_GROUPS.find((g) => g.id === groupId);
            if (!group) {
              toolResult = JSON.stringify({ success: false, error: `Unknown group "${groupId}". Call guardian_list_tool_groups to see available groups.` });
              isError = true;
            } else {
              // Find tools from allFocusTools that match this group but aren't already in mcpTools.
              const existingNames = new Set(mcpTools.map((t) => t.name));
              const newTools = allFocusTools.filter((t) => {
                if (existingNames.has(t.name)) return false;
                let rawName = t.name;
                for (const entry of instanceManifest) {
                  if (t.name.startsWith(entry.toolPrefix)) {
                    rawName = t.name.slice(entry.toolPrefix.length);
                    break;
                  }
                }
                return group.toolPatterns.some((p) => rawName === p || rawName.startsWith(p + "_"));
              });
              mcpTools.push(...newTools);
              toolResult = JSON.stringify({
                success: true,
                loaded: newTools.length,
                tools: newTools.map((t) => t.name),
                totalTools: mcpTools.length,
              });
            }
          } else if (tc.name === "guardian_list_tool_groups") {
            // Smart Tool Selection: list available groups with tool counts.
            const groups = TOOL_GROUPS.map((g) => {
              const toolCount = allFocusTools.filter((t) => {
                let rawName = t.name;
                for (const entry of instanceManifest) {
                  if (t.name.startsWith(entry.toolPrefix)) {
                    rawName = t.name.slice(entry.toolPrefix.length);
                    break;
                  }
                }
                return g.toolPatterns.some((p) => rawName === p || rawName.startsWith(p + "_"));
              }).length;
              const loadedCount = mcpTools.filter((t) => {
                let rawName = t.name;
                for (const entry of instanceManifest) {
                  if (t.name.startsWith(entry.toolPrefix)) {
                    rawName = t.name.slice(entry.toolPrefix.length);
                    break;
                  }
                }
                return g.toolPatterns.some((p) => rawName === p || rawName.startsWith(p + "_"));
              }).length;
              return {
                id: g.id,
                label: g.label,
                category: g.category,
                description: g.description,
                totalTools: toolCount,
                loadedTools: loadedCount,
                fullyLoaded: loadedCount >= toolCount,
              };
            }).filter((g) => g.totalTools > 0);
            toolResult = JSON.stringify({ success: true, groups });
          } else if (useV2 && tc.name.startsWith("guardian_") && ["guardian_list_instances", "guardian_get_instance_tools", "guardian_call_instance_tool"].includes(tc.name)) {
            // V2: Guardian meta-tool (instance discovery / proxy)
            const result = await executeGuardianMetaTool({
              userId: params.userId,
              manifest: instanceManifest,
              toolName: tc.name,
              args: tc.arguments,
              pluginClientId: currentPluginClientId,
            });
            toolResult = result.success
              ? JSON.stringify(result.result ?? { success: true })
              : formatToolError(tc.name, result.error, { source: "Guardian meta-tool" });
            isError = !result.success;
          } else if (useV2) {
            // V2: instance-based MCP tool execution
            const resolved = resolveV2Tool(tc.name, instanceManifest);
            if (resolved) {
              const manifestEntry = instanceManifest.find((e) => e.instanceId === resolved.instanceId);
              const result = await executeMCPToolV2({
                userId: params.userId,
                instanceId: resolved.instanceId,
                toolName: resolved.rawName,
                arguments: tc.arguments,
                pluginClientId: currentPluginClientId,
              });
              toolResult = result.success
                ? JSON.stringify(result.result ?? { success: true })
                : formatToolError(tc.name, result.error, {
                    source: manifestEntry?.displayName ?? manifestEntry?.presetType ?? "MCP instance",
                    label: manifestEntry?.label,
                  });
              isError = !result.success;
            } else {
              // Fallback: try V1 resolution (e.g., guardian_ prefix tools)
              const resolvedV1 = resolveServerForTool(tc.name);
              const result = await executeMCPTool({
                userId: params.userId,
                serverId: resolvedV1.serverId,
                toolName: resolvedV1.rawName,
                arguments: tc.arguments,
                pluginClientId: currentPluginClientId,
              });
              toolResult = result.success
                ? JSON.stringify(result.result ?? { success: true })
                : formatToolError(tc.name, result.error, { source: resolvedV1.serverId });
              isError = !result.success;
            }
          } else {
            // Legacy V1: MCP tool execution (Guardian or external MCP servers)
            const resolved = resolveServerForTool(tc.name);
            const result = await executeMCPTool({
              userId: params.userId,
              serverId: resolved.serverId,
              toolName: resolved.rawName,
              arguments: tc.arguments,
              pluginClientId: currentPluginClientId,
            });
            toolResult = result.success
              ? JSON.stringify(result.result ?? { success: true })
              : formatToolError(tc.name, result.error, { source: resolved.serverId });
            isError = !result.success;
          }
        } catch (err) {
          toolResult = formatToolError(tc.name, err instanceof Error ? err.message : String(err), { source: "tool execution" });
          isError = true;
        }

        // Notify browser: tool execution complete (non-fatal if broadcast fails)
        try {
          await broadcastChatEvent({
            conversationId: params.conversationId,
            event: "tool_call_result",
            payload: { toolCallId: tc.id, result: toolResult, isError },
          });
        } catch {
          // Broadcast failure is non-fatal
        }

        messages.push({
          role: "tool",
          content: toolResult,
          toolCallId: tc.id,
        });

        // Persist tool call to DB for F5 recovery
        await persistChatMessage({
          conversationId: params.conversationId,
          role: "assistant",
          content: `Tool: ${tc.name}`,
          userId: params.userId,
          parts: [{
            type: "dynamic-tool",
            toolName: tc.name,
            toolCallId: tc.id,
            input: tc.arguments,
            state: isError ? "error" : "output-available",
            output: { content: [{ type: "text", text: toolResult }], isError },
          }],
        });
      }

      // Continue loop → LLM gets tool results and responds again
      status = "streaming";
    }

    // Max steps reached
    if (currentStep >= MAX_STEPS) {
      const truncationMsg = "[Response truncated: maximum tool execution steps reached]";
      messages.push({ role: "assistant", content: truncationMsg });
      await persistChatMessage({
        conversationId: params.conversationId,
        role: "assistant",
        content: truncationMsg,
        userId: params.userId,
        metadata: { truncated: true },
      });
    }
  }
  } // end runChatWorkflowBody
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Known tool prefixes → server IDs (must match MCP_SERVERS in mcp.ts) */
const TOOL_PREFIX_MAP: Array<[string, string]> = [
  ["guardian_", "guardian"],
  ["figmaconsole_", "figma_console"],
  ["figma_", "figma_mcp"],
  ["github_", "github"],
];

/**
 * Format a tool execution error with provider/instance context and an
 * actionable hint when we can detect a known failure pattern.
 *
 * Legacy parity: the old `/api/chat` route hand-crafted error messages with
 * provider names and auth/rate-limit hints. During the Temporal migration
 * the activities started returning raw errors, making it hard for users to
 * tell WHICH connection broke (e.g. "Error: 401 Unauthorized" with no
 * indication of whether it's the Figma MCP or the GitHub API).
 *
 * This helper wraps the raw error with:
 *   - A "[<source>]" prefix identifying the instance/server
 *   - The raw error message
 *   - A pattern-matched hint ("rate limited", "authentication failed", ...)
 *
 * Pure function — deterministic string manipulation only, safe to call from
 * a Temporal workflow.
 */
function formatToolError(
  toolName: string,
  rawError: string | undefined,
  ctx: { source: string; label?: string },
): string {
  const err = rawError ?? "unknown error";
  const sourceLabel = ctx.label ? `${ctx.source} (${ctx.label})` : ctx.source;

  // Pattern-match common failure classes so the user sees a one-line
  // actionable hint alongside the raw error instead of having to decode
  // "401 Unauthorized" themselves.
  let hint = "";
  const lower = err.toLowerCase();

  if (/401|unauthori[sz]ed|invalid.?(api.?)?key|not.?authenticated/.test(lower)) {
    hint = " — Authentication failed. Re-check your API key or reconnect this instance in Account > Developers.";
  } else if (/403|forbidden|permission.?denied|access.?denied/.test(lower)) {
    hint = " — Permission denied. Verify this account has access to the resource, or reconnect with broader scopes.";
  } else if (/429|rate.?limit|too.?many.?requests|quota.?exceeded/.test(lower)) {
    hint = " — Rate limit or quota exceeded on the provider side. Wait a moment and retry, or switch to a different instance.";
  } else if (/timeout|timed.?out|econnreset|econnrefused|network/.test(lower)) {
    hint = " — Network / timeout error reaching the provider. The instance may be offline — check its status in Account > Developers.";
  } else if (/not.?found|404/.test(lower)) {
    hint = " — Resource not found. Double-check the target (file, repo, node) exists and is spelled correctly.";
  } else if (/plugin.?(is.?not.?|isn.?t.?|not.?)connected|no.?plugin.?connected/.test(lower)) {
    hint = " — The Figma plugin bridge is not connected. Open the Guardian plugin in Figma and reload it, then retry.";
  }

  return `[${sourceLabel}] Tool ${toolName} failed: ${err}${hint}`;
}

function resolveServerForTool(prefixedName: string): { serverId: string; rawName: string } {
  for (const [prefix, serverId] of TOOL_PREFIX_MAP) {
    if (prefixedName.startsWith(prefix)) {
      return { serverId, rawName: prefixedName.slice(prefix.length) };
    }
  }
  // Fallback: assume guardian
  return { serverId: "guardian", rawName: prefixedName };
}

/**
 * V2: resolve a prefixed tool name against the instance manifest.
 * Tool name format: <preset_slug>_<label>_<raw_tool_name>
 * Returns the instanceId and raw tool name, or null if no match.
 */
function resolveV2Tool(
  prefixedName: string,
  manifest: InstanceManifestEntry[],
): { instanceId: string; rawName: string } | null {
  for (const entry of manifest) {
    if (prefixedName.startsWith(entry.toolPrefix)) {
      return {
        instanceId: entry.instanceId,
        rawName: prefixedName.slice(entry.toolPrefix.length),
      };
    }
  }
  return null;
}

/**
 * V2: build the system prompt block describing available instances.
 * Imported from guardian-meta-tools but kept pure (no activity call) since
 * Temporal workflows cannot call non-deterministic code.
 */
function buildManifestPrompt(manifest: InstanceManifestEntry[]): string {
  if (manifest.length === 0) return "";
  const lines: string[] = ["## Tool instances and labels", ""];
  const byCategory: Record<string, InstanceManifestEntry[]> = {};
  for (const e of manifest) {
    (byCategory[e.category] ??= []).push(e);
  }
  let hasUnavailable = false;
  for (const [cat, entries] of Object.entries(byCategory)) {
    lines.push(`${cat.charAt(0).toUpperCase() + cat.slice(1)}:`);
    for (const e of entries) {
      const focus = e.isFocus ? " ← FOCUS" : "";
      const scope = e.scope === "local" ? " [local bridged]" : "";
      const name = e.displayName ?? e.presetType;

      if (e.error) {
        hasUnavailable = true;
        const shortError = e.error.length > 120 ? e.error.slice(0, 120) + "…" : e.error;
        lines.push(`- ${name} (${e.label})${scope} ⚠️ UNAVAILABLE`);
        lines.push(`  Reason: ${shortError}`);
        lines.push(`  DO NOT call tools on this instance. DO NOT call guardian_call_instance_tool with label="${e.label}".`);
        lines.push(`  If user asks about ${name}, tell them: "${name} is not reachable (reason: ${shortError}). Please reconnect it in Account page."`);
      } else {
        lines.push(`- ${name} (${e.label})${scope}${focus}`);
        if (e.toolNames.length > 0 && !e.isFocus) {
          lines.push(`  Tools: ${e.toolNames.join(", ")}`);
        }
      }
    }
    lines.push("");
  }
  lines.push(
    "",
    "Tool naming: `<preset>_<label>_<action>` (e.g. `github_github_list_repos`).",
    "Default: use focus tools directly. For other instances, call `guardian_call_instance_tool(label, raw_tool_name, args)`.",
    "  - `tool_name` = RAW name without prefix (e.g. `list_repos`, NOT `github_github_list_repos`).",
    "",
  );

  if (hasUnavailable) {
    lines.push(
      "## UNAVAILABLE instances — CRITICAL",
      "",
      "Any instance marked ⚠️ UNAVAILABLE has failed discovery and CANNOT be called.",
      "- DO NOT call `guardian_call_instance_tool` with its label.",
      "- DO NOT call any tool with its prefix.",
      "- DO NOT try to use it as a fallback 'just in case' — the error will propagate and waste a turn.",
      "- If the user asks for something involving an UNAVAILABLE instance:",
      "  1. Try another instance in the same category (e.g. figmaconsole instead of figma).",
      "  2. Check if a Figma plugin is connected (presence) → use `figma_plugin_execute` as alternative.",
      "  3. Otherwise, tell the user the canned reconnect message from the instance entry above — do NOT narrate a long procedure.",
      "",
    );
  }

  lines.push(
    "IMPORTANT: Figma plugins (presence entries like 'Figma-Desktop-xxxxx') are NOT MCP instances.",
    "Do NOT use guardian_call_instance_tool with plugin names — use `figma_plugin_execute` instead.",
    "Only use instance labels shown above (e.g. 'figma', 'figmaconsole', 'github').",
  );
  return lines.join("\n");
}
