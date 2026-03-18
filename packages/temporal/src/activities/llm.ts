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
const DELEGATABLE_PURPOSES: LLMCallPurpose[] = ["code_review", "file_review"];

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
  timeoutMs = 120_000
): Promise<LLMCallResult> {
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

  return new Promise<LLMCallResult>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        log.warn("delegate timed out — falling back to passthrough", { req: requestId });
        // Fallback: call the LLM directly on timeout
        callLLMDirect(params).then(resolve);
      }
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      channel.unsubscribe();
    }

    channel
      .on("broadcast", { event: "intercept_response" }, (payload) => {
        const data = payload.payload;
        if (data?.requestId === requestId && !settled) {
          settled = true;
          cleanup();
          log.info("received delegate response", { req: requestId, contentLen: data.content?.length ?? 0 });
          resolve({
            content: data.content ?? "",
            intercepted: {
              action: "delegated",
              reason: `Delegated to external responder (${params.purpose})`,
              originalModel: params.model,
            },
          });
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
  const { generateText, jsonSchema } = await import("ai");

  const resolved = await resolveModelForActivity(params.userId, params.model);

  const toolSet = params.tools
    ? Object.fromEntries(
        params.tools.map((t) => [
          t.name,
          {
            description: t.description,
            inputSchema: jsonSchema(t.parameters),
          },
        ])
      )
    : undefined;

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
    model: resolved.model,
    messages,
    maxOutputTokens: params.maxTokens ?? 4096,
    tools: toolSet,
  });

  // Extract reasoning if the model provides it (e.g. kimi-k2.5, grok reasoning)
  const reasoningParts = result.reasoning;
  const reasoning = reasoningParts?.length
    ? reasoningParts
        .filter((p: { type: string }) => p.type === "text")
        .map((p: { type: string; text?: string }) => p.text ?? "")
        .join("\n")
    : undefined;

  return {
    content: result.text,
    reasoning,
    toolCalls: result.toolCalls?.map((tc: { toolCallId: string; toolName: string; input?: unknown; args?: unknown }) => ({
      id: tc.toolCallId,
      name: tc.toolName,
      arguments: (tc.input ?? tc.args ?? {}) as Record<string, unknown>,
    })),
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
