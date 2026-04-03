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
  condition,
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
  type ChatNewMessagePayload,
  type ChatWorkflowStatus,
} from "../signals/definitions.js";

import type {
  StreamingLLMActivities,
  ChatPersistenceActivities,
  ChatBroadcastActivities,
  FigmaActivities,
  MCPActivities,
} from "../activities/types.js";

// ---------------------------------------------------------------------------
// Activity proxies
// ---------------------------------------------------------------------------

const { callLLMStreaming } = proxyActivities<StreamingLLMActivities>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 2 },
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

const { discoverMCPTools, executeMCPTool } = proxyActivities<MCPActivities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 2 },
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
  /** MCP server IDs to connect */
  mcpServerIds?: string[];
  /** Figma plugin client ID (for figma_execute tool) */
  figmaPluginClientId?: string;
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
  let cancelled = false;
  let status: ChatWorkflowStatus["status"] = "idle";
  let streamingRequestId: string | undefined;
  let currentStep = 0;
  let errorMessage: string | undefined;

  // Pending messages from signals
  const pendingMessages: ChatNewMessagePayload[] = [];

  // ── Signal handlers ─────────────────────────────────────────────────────
  setHandler(chatNewMessageSignal, (msg) => {
    pendingMessages.push(msg);
  });

  setHandler(chatCancelSignal, () => {
    cancelled = true;
  });

  // ── Query handler ───────────────────────────────────────────────────────
  setHandler(chatStatusQuery, () => ({
    conversationId: params.conversationId,
    status,
    streamingRequestId,
    currentStep,
    errorMessage,
  }));

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
  // Always include the Guardian MCP (built-in), plus user-enabled external MCPs
  const allMcpServerIds = ["guardian", ...(params.mcpServerIds ?? [])];
  let mcpTools: LLMToolDefinition[] = [];
  try {
    mcpTools = await discoverMCPTools({
      userId: params.userId,
      mcpServerIds: allMcpServerIds,
      pluginClientId: params.figmaPluginClientId,
    });
  } catch {
    // Non-fatal: continue without MCP tools
  }

  // ── Process first message ───────────────────────────────────────────────
  await processUserMessage(params.userMessage, params.userImages);

  // ── Idle loop: wait for follow-up messages ──────────────────────────────
  while (!cancelled) {
    status = "idle";
    streamingRequestId = undefined;
    currentStep = 0;

    const hasMessage = await condition(() => pendingMessages.length > 0 || cancelled, IDLE_TIMEOUT_MS);
    if (!hasMessage || cancelled) break;

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

  status = cancelled ? "cancelled" : "completed";

  // ── Helper: process user message (first or from signal) ─────────────────

  async function processUserMessage(content: string, images?: string[]) {
    messages.push({ role: "user", content, images });
    await runLLMLoop();
  }

  // ── Helper: LLM ↔ tool execution loop ──────────────────────────────────

  async function runLLMLoop() {
    status = "streaming";
    currentStep = 0;

    while (currentStep < MAX_STEPS && !cancelled) {
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
          model: params.model,
          userId: params.userId,
        });
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        status = "error";
        // Persist error as assistant message
        await persistChatMessage({
          conversationId: params.conversationId,
          role: "assistant",
          content: `[Error: ${errorMessage}]`,
          userId: params.userId,
          metadata: { error: true },
        });
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
          } else {
            // MCP tool execution (Guardian or external MCP servers)
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
            payload: { toolCallId: tc.id, result: toolResult.slice(0, 500), isError },
          });
        } catch {
          // Broadcast failure is non-fatal
        }

        messages.push({
          role: "tool",
          content: toolResult,
          toolCallId: tc.id,
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
