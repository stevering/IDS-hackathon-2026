/**
 * LLM activity — calls the AI model via the shared model resolver.
 *
 * This activity runs in the Temporal worker process (Node.js)
 * and has access to environment variables and network.
 *
 * ## Interceptor
 *
 * Every callLLM() goes through an interceptor that decides how to handle it:
 *
 * - **passthrough** (default): call the AI SDK normally
 * - **synthetic_response**: return a hardcoded response without calling any LLM
 *   (e.g. auto-approve kimi code reviews that have high false-positive rates)
 * - **delegate** (dev-only): send the request to an external responder (Claude Code,
 *   or any client listening on the Supabase Realtime channel) and wait for their response.
 *   Activated per-user via the "LLM call delegation" toggle in Account > Developers.
 *   The external responder uses the `watch_intercepts` / `respond_to_intercept` MCP tools
 *   or the SSE endpoint at /api/intercept/stream.
 *   Falls back to passthrough after 120s timeout.
 *
 * The interceptor decision is based on:
 * - params.purpose: "code_review", "file_review", "agent", "orchestrator"
 * - params.model: which AI provider model is configured
 * - params.tracing.devLLMDelegation: user setting from Account > Developers
 *
 * The `intercepted` field in LLMCallResult tells the caller and the event stream
 * that the call was modified (action, reason, originalModel).
 */

import { createClient } from "@supabase/supabase-js";
import type { LLMCallParams, LLMCallResult, LLMCallPurpose } from "@guardian/orchestrations";
import { createLogger } from "../lib/log.js";

// ---------------------------------------------------------------------------
// Gateway model capabilities cache (public API, refreshed every 24h)
// ---------------------------------------------------------------------------

const GATEWAY_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";
const CAPABILITIES_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Set of model IDs that have native reasoning support. */
let reasoningModels: Set<string> = new Set();
let capabilitiesFetchedAt = 0;

async function refreshCapabilitiesCache(): Promise<void> {
  try {
    const res = await fetch(GATEWAY_CATALOG_URL);
    if (!res.ok) return;
    const json = await res.json();
    const models: Array<{ id: string; tags?: string[] }> = json?.data ?? [];
    const newSet = new Set<string>();
    for (const m of models) {
      if (m.tags?.includes("reasoning")) newSet.add(m.id);
    }
    reasoningModels = newSet;
    capabilitiesFetchedAt = Date.now();
  } catch {
    // Non-fatal: keep existing cache
  }
}

async function modelSupportsReasoning(modelId: string): Promise<boolean> {
  if (reasoningModels.size === 0 || Date.now() - capabilitiesFetchedAt > CAPABILITIES_TTL_MS) {
    await refreshCapabilitiesCache();
  }
  return reasoningModels.has(modelId);
}

// ---------------------------------------------------------------------------
// Interceptor types
// ---------------------------------------------------------------------------

type InterceptDecision =
  | { action: "passthrough" }
  | { action: "synthetic"; result: LLMCallResult }
  | { action: "delegate" };

// ---------------------------------------------------------------------------
// Delegate rules (dev-only) — uncomment to route specific calls to Claude Code
// ---------------------------------------------------------------------------

/** Purposes that can be delegated when the user enables devLLMDelegation in settings. */
const DELEGATABLE_PURPOSES: LLMCallPurpose[] = ["code_review", "file_review", "agent", "orchestrator"];

// ---------------------------------------------------------------------------
// LLM Call Interceptor
// ---------------------------------------------------------------------------

function interceptLLMCall(params: LLMCallParams): InterceptDecision {
  const model = params.model ?? "";
  const purpose = params.purpose;


  // Rule: kimi models for code_review or file_review → auto-approve without calling LLM
  if (purpose === "code_review" && model.includes("kimi")) {
    return {
      action: "synthetic",
      result: {
        content: "APPROVED",
        intercepted: {
          action: "auto_approved",
          reason: `Interceptor: ${model} skipped for code_review (high false-positive rate)`,
          originalModel: model,
        },
      },
    };
  }

  if (purpose === "file_review" && model.includes("kimi")) {
    return {
      action: "synthetic",
      result: {
        content: "VERIFIED: Execution result accepted (review skipped by interceptor)",
        intercepted: {
          action: "auto_verified",
          reason: `Interceptor: ${model} skipped for file_review (high false-positive rate)`,
          originalModel: model,
        },
      },
    };
  }

  // Delegate (dev-only): enabled per-user via settings, guarded by NODE_ENV
  if (
    process.env.NODE_ENV !== "production" &&
    purpose &&
    params.tracing?.devLLMDelegation &&
    DELEGATABLE_PURPOSES.includes(purpose)
  ) {
    return { action: "delegate" };
  }

  return { action: "passthrough" };
}

// ---------------------------------------------------------------------------
// Delegate to external responder via Supabase Realtime (dev-only)
// ---------------------------------------------------------------------------

async function delegateToExternal(
  params: LLMCallParams,
): Promise<LLMCallResult> {
  // Slow delegation: 30 min timeout for interactive use; normal: 120s
  const timeoutMs = params.tracing?.devSlowDelegation ? 30 * 60_000 : 120_000;
  const tablePollMs = 2_000; // Poll the table every 2s for SQL-based responses
  const log = createLogger("llm-delegate", {
    u: params.userId.slice(0, 8),
    purpose: params.purpose ?? "unknown",
  });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    log.error("Supabase credentials not configured — falling back to passthrough");
    return callLLMDirect(params);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const channelName = `guardian:intercept:${params.userId}`;
  const channel = supabase.channel(channelName);
  const requestId = `intercept-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  log.info("delegating LLM call to external responder", { req: requestId, model: params.model, timeout: timeoutMs });

  // Step 1: INSERT into intercept_queue (persistent storage)
  try {
    await supabase.from("intercept_queue").insert({
      request_id: requestId,
      user_id: params.userId,
      conversation_type: params.tracing?.conversationType ?? null,
      conversation_id: params.tracing?.conversationId ?? null,
      orchestration_id: params.tracing?.orchestrationId ?? null,
      agent_short_id: params.tracing?.agentShortId ?? null,
      agent_workflow_id: null, // TODO: pass from tracing when available
      agent_type: null,
      agent_label: null,
      agent_file_name: null,
      purpose: params.purpose ?? "unknown",
      model: params.model ?? null,
      current_directive: params.tracing?.currentDirective ?? null,
      step_count: params.tracing?.stepCount ?? null,
      exec_stats: params.tracing?.execStats ?? null,
      status: "pending",
      request_payload: {
        messages: params.messages,
        tools: params.tools,
        maxTokens: params.maxTokens,
      },
    });
  } catch (insertErr) {
    log.warn("failed to INSERT into intercept_queue (non-fatal)", { error: String(insertErr) });
    // Continue — the broadcast will still work for MCP/SSE responders
  }

  // Step 2: Subscribe to Realtime + broadcast request + poll table
  return new Promise<LLMCallResult>((resolve) => {
    let settled = false;
    let tablePoller: ReturnType<typeof setInterval> | null = null;

    function handleResponse(data: { content?: string; toolCalls?: unknown; respondedBy?: string }) {
      if (settled) return;
      settled = true;
      cleanup();
      log.info("received delegate response", {
        req: requestId,
        contentLen: data.content?.length ?? 0,
        hasToolCalls: !!data.toolCalls,
        via: data.respondedBy ?? "realtime",
      });
      resolve({
        content: data.content ?? "",
        toolCalls: data.toolCalls as LLMCallResult["toolCalls"],
        intercepted: {
          action: "delegated",
          reason: `Delegated to external responder (${params.purpose})`,
          originalModel: params.model,
        },
      });
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        // Mark as expired in table
        supabase.from("intercept_queue")
          .update({ status: "expired", expired_at: new Date().toISOString() })
          .eq("request_id", requestId)
          .then(() => {});
        log.warn("delegate timed out — falling back to passthrough", { req: requestId });
        callLLMDirect(params).then(resolve);
      }
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      if (tablePoller) clearInterval(tablePoller);
      channel.unsubscribe();
    }

    // Poll the table for SQL-based responses (e.g. from Claude Code execute_sql)
    tablePoller = setInterval(async () => {
      if (settled) return;
      try {
        const { data: rows } = await supabase
          .from("intercept_queue")
          .select("response_content, response_tool_calls, responded_by")
          .eq("request_id", requestId)
          .eq("status", "responded")
          .limit(1);
        if (rows?.[0]) {
          handleResponse({
            content: rows[0].response_content,
            toolCalls: rows[0].response_tool_calls,
            respondedBy: rows[0].responded_by ?? "sql",
          });
        }
      } catch { /* best-effort polling */ }
    }, tablePollMs);

    // Listen for Realtime broadcast responses (from MCP tools)
    channel
      .on("broadcast", { event: "intercept_response" }, (payload) => {
        const data = payload.payload;
        if (data?.requestId === requestId) {
          // Also update the table so it's consistent
          supabase.from("intercept_queue")
            .update({
              status: "responded",
              response_content: data.content,
              response_tool_calls: data.toolCalls,
              responded_by: "realtime",
              responded_at: new Date().toISOString(),
            })
            .eq("request_id", requestId)
            .then(() => {});
          handleResponse({ content: data.content, toolCalls: data.toolCalls, respondedBy: "realtime" });
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log.info("channel subscribed, broadcasting intercept_request", { req: requestId });
          channel.send({
            type: "broadcast",
            event: "intercept_request",
            payload: {
              requestId,
              timestamp: new Date().toISOString(),
              context: {
                conversationType: params.tracing?.conversationType ?? "unknown",
                conversationId: params.tracing?.conversationId,
                orchestrationId: params.tracing?.orchestrationId,
                agentShortId: params.tracing?.agentShortId,
                purpose: params.purpose ?? "unknown",
                currentDirective: params.tracing?.currentDirective,
                stepCount: params.tracing?.stepCount,
                execStats: params.tracing?.execStats,
              },
              llm: {
                model: params.model,
                messages: params.messages,
                tools: params.tools,
                maxTokens: params.maxTokens,
              },
            },
          });
        }
      });
  });
}

// ---------------------------------------------------------------------------
// Direct LLM call (the original implementation, extracted for reuse)
// ---------------------------------------------------------------------------

async function callLLMDirect(params: LLMCallParams): Promise<LLMCallResult> {
  const { resolveModelForActivity } = await import("./llm-resolver.js");
  const { generateText, jsonSchema, wrapLanguageModel, extractReasoningMiddleware } = await import("ai");

  const resolved = await resolveModelForActivity(params.userId, params.model);

  // For models without native reasoning, wrap with extractReasoningMiddleware
  // so <thinking> tags in text become reasoning parts (same approach as chat route).
  const hasNativeReasoning = await modelSupportsReasoning(resolved.modelId);
  const model = hasNativeReasoning
    ? resolved.model
    : wrapLanguageModel({
        model: resolved.model as Parameters<typeof wrapLanguageModel>[0]["model"],
        middleware: extractReasoningMiddleware({ tagName: "thinking" }),
      });

  const toolSet = params.tools
    ? Object.fromEntries(
        params.tools.map((t) => [
          t.name,
          {
            description: t.description,
            // AI SDK v6 requires a validate function to parse LLM tool call arguments.
            // Without it, args are returned as {}. Passthrough validator accepts any input.
            inputSchema: jsonSchema(t.parameters, {
              validate: (value) => ({ success: true as const, value }),
            }),
          },
        ])
      )
    : undefined;

  // For non-reasoning models, inject <thinking> instruction into the system prompt
  // so the middleware can extract reasoning from the generated text.
  if (!hasNativeReasoning) {
    const systemIdx = params.messages.findIndex((m) => m.role === "system");
    if (systemIdx !== -1) {
      params.messages[systemIdx] = {
        ...params.messages[systemIdx],
        content: params.messages[systemIdx].content +
          "\n\n## THINKING PROCESS\nWhile you work, emit your reasoning inside <thinking>...</thinking> blocks.\nKeep thinking blocks short (1-2 sentences).",
      };
    }
  }

  // Convert our LLMMessage[] to AI SDK format.
  // Tool-call/tool-result messages are flattened to text so that
  // ALL providers (Kimi, xAI, OpenAI, etc.) handle them correctly.
  const messages = params.messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      const toolSummary = m.toolCalls
        .map((tc) => `[Called tool: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})]`)
        .join("\n");
      return {
        role: "assistant" as const,
        content: (m.content || "") + "\n" + toolSummary,
      };
    }
    if (m.role === "tool") {
      if (m.images?.length) {
        const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [
          { type: "text", text: `[Tool result] ${m.content}` },
        ];
        for (const img of m.images) {
          parts.push({ type: "image", image: img });
        }
        return { role: "user" as const, content: parts };
      }
      return {
        role: "user" as const,
        content: `[Tool result] ${m.content}`,
      };
    }
    // Multimodal: if the message has images, use content parts array
    if (m.images?.length && m.role === "user") {
      const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [
        { type: "text", text: m.content },
      ];
      for (const img of m.images) {
        parts.push({ type: "image", image: img });
      }
      return {
        role: "user" as const,
        content: parts,
      };
    }
    return {
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    };
  });

  const result = await generateText({
    model,
    messages,
    maxOutputTokens: params.maxTokens ?? 4096,
    tools: toolSet,
  });

  // Extract reasoning if the model provides it (e.g. kimi-k2.5, grok reasoning)
  // AI SDK v6 (LMS v3): reasoning parts have type "reasoning" (not "text")
  const reasoning = result.reasoningText ?? undefined;

  return {
    content: result.text,
    reasoning,
    reasoningSimulated: !hasNativeReasoning && !!reasoning,
    toolCalls: result.toolCalls?.map((tc: Record<string, unknown>) => {
      // AI SDK v6: StaticToolCall has .args, DynamicToolCall (MCP) has .input
      const args = (tc.args ?? tc.input ?? {}) as Record<string, unknown>;
      if (Object.keys(args).length === 0) {
        console.warn(`[callLLM] Empty args for tool ${tc.toolName}`, { rawKeys: Object.keys(tc).join(","), rawTc: JSON.stringify(tc).slice(0, 500) });
      }
      return { id: tc.toolCallId as string, name: tc.toolName as string, arguments: args };
    }),
    usage: result.usage
      ? {
          promptTokens: (result.usage as { inputTokens?: number }).inputTokens ?? 0,
          completionTokens: (result.usage as { outputTokens?: number }).outputTokens ?? 0,
          totalTokens:
            ((result.usage as { inputTokens?: number }).inputTokens ?? 0) +
            ((result.usage as { outputTokens?: number }).outputTokens ?? 0),
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function callLLM(params: LLMCallParams): Promise<LLMCallResult> {
  const decision = interceptLLMCall(params);

  if (decision.action === "synthetic") return decision.result;
  if (decision.action === "delegate") return delegateToExternal(params);

  // passthrough — call the AI provider directly
  return callLLMDirect(params);
}
