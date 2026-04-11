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

  // ── Load conversation history ───────────────────────────────────────────
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
  if (useV2 && instanceManifest.length > 0) {
    // Add the 3 meta-tools to the catalog (always available)
    const metaSpecs: LLMToolDefinition[] = [
      { name: "guardian_list_instances", description: "List all MCP instances the user has configured and that are currently online.", parameters: { type: "object", properties: {}, required: [] } },
      { name: "guardian_get_instance_tools", description: "Get the list of tools exposed by a specific MCP instance (by label).", parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } },
      { name: "guardian_call_instance_tool", description: "Execute a tool on a non-focus MCP instance (by label).", parameters: { type: "object", properties: { label: { type: "string" }, tool_name: { type: "string" }, arguments: { type: "object" } }, required: ["label", "tool_name", "arguments"] } },
    ];
    mcpTools.push(...metaSpecs);

    // Inject the instance manifest into the system prompt.
    //
    // Guard: `messages` may be empty here if the caller passed no systemPrompt
    // AND history is empty (brand-new conversation started via a path that
    // doesn't set a system prompt — e.g., a misconfigured integration test).
    // Spreading `messages[0]` when it's undefined crashes the workflow at
    // boot. Instead, prepend a fresh system message when empty.
    const manifestBlock = buildManifestPrompt(instanceManifest);
    if (manifestBlock) {
      const first = messages[0];
      if (first && first.role === "system") {
        messages[0] = {
          ...first,
          content: (first.content ?? "") + "\n\n" + manifestBlock,
        };
      } else {
        messages.unshift({ role: "system", content: manifestBlock });
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
  await processUserMessage(params.userMessage, params.userImages);

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

    // Persist user message
    await persistChatMessage({
      conversationId: params.conversationId,
      role: "user",
      content: nextMsg.content,
      userId: params.userId,
    });
    messages.push({ role: "user", content: nextMsg.content, images: nextMsg.images });

    await runLLMLoop();
  }

  status = "completed";

  // ── Helper: process user message (first or from signal) ─────────────────

  async function processUserMessage(content: string, images?: string[]) {
    messages.push({ role: "user", content, images });
    await runLLMLoop();
  }

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
          if ((tc.name === "guardian_figma_execute" || tc.name === "figma_plugin_execute") && params.figmaPluginClientId) {
            // Figma code execution via plugin bridge (direct Supabase Realtime)
            const code = (tc.arguments.code as string) ?? "";
            const result = await executeFigmaCode({
              pluginClientId: params.figmaPluginClientId,
              userId: params.userId,
              code,
              workflowId,
            });
            toolResult = result.success
              ? JSON.stringify(result.result ?? { success: true })
              : `Error: ${result.error ?? "unknown"}`;
            isError = !result.success;
          } else if (useV2 && tc.name.startsWith("guardian_") && ["guardian_list_instances", "guardian_get_instance_tools", "guardian_call_instance_tool"].includes(tc.name)) {
            // V2: Guardian meta-tool (instance discovery / proxy)
            const result = await executeGuardianMetaTool({
              userId: params.userId,
              manifest: instanceManifest,
              toolName: tc.name,
              args: tc.arguments,
            });
            toolResult = result.success
              ? JSON.stringify(result.result ?? { success: true })
              : `Error: ${result.error ?? "unknown"}`;
            isError = !result.success;
          } else if (useV2) {
            // V2: instance-based MCP tool execution
            const resolved = resolveV2Tool(tc.name, instanceManifest);
            if (resolved) {
              const result = await executeMCPToolV2({
                userId: params.userId,
                instanceId: resolved.instanceId,
                toolName: resolved.rawName,
                arguments: tc.arguments,
              });
              toolResult = result.success
                ? JSON.stringify(result.result ?? { success: true })
                : `Error: ${result.error ?? "unknown"}`;
              isError = !result.success;
            } else {
              // Fallback: try V1 resolution (e.g., guardian_ prefix tools)
              const resolvedV1 = resolveServerForTool(tc.name);
              const result = await executeMCPTool({
                userId: params.userId,
                serverId: resolvedV1.serverId,
                toolName: resolvedV1.rawName,
                arguments: tc.arguments,
              });
              toolResult = result.success
                ? JSON.stringify(result.result ?? { success: true })
                : `Error: ${result.error ?? "unknown"}`;
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
            });
            toolResult = result.success
              ? JSON.stringify(result.result ?? { success: true })
              : `Error: ${result.error ?? "unknown"}`;
            isError = !result.success;
          }
        } catch (err) {
          toolResult = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
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
