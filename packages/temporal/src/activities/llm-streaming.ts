/**
 * Streaming LLM activity — calls the AI model with streamText() and
 * broadcasts token deltas via Supabase Realtime.
 *
 * Used by both the chatWorkflow (regular conversations) and orchestration
 * workflows (collab agents) for real-time token streaming to the browser.
 *
 * Broadcasts on channel `guardian:chat:{conversationId}`:
 *   - text_delta      — text chunk
 *   - reasoning_delta  — reasoning/thinking chunk
 *   - tool_call_start  — tool call emitted by the LLM
 *   - text_complete    — full text after streaming ends (with usage)
 *
 * The activity returns the same LLMCallResult shape as callLLM,
 * so workflows can switch between batch and streaming transparently.
 */

import { createClient } from "@supabase/supabase-js";
import { CancelledFailure, Context, heartbeat } from "@temporalio/activity";
import type { LLMCallParams, LLMCallResult } from "@guardian/orchestrations";
import { createLogger } from "../lib/log.js";
import { redactMessage } from "../lib/redact.js";

// Heartbeat frequency matters for cancellation latency: Temporal delivers
// activity cancellation notices on heartbeat responses, so the smaller this
// interval the faster `ctx.cancellationSignal` aborts when the user clicks
// Stop. 1s gives near-instant perceived cancellation without noticeable
// overhead for typical LLM streams.
const HEARTBEAT_INTERVAL_MS = 1_000;
const BROADCAST_BUFFER_MS = 50; // Minimum interval between broadcasts to avoid flooding
const FIRST_TOKEN_TIMEOUT_MS = 120_000; // Abort if no token arrives within 120s
const DB_SNAPSHOT_INTERVAL_MS = parseInt(process.env.CHAT_SNAPSHOT_INTERVAL_MS ?? "2000"); // Persist partial text to DB (default 2s, override via env for testing)

export type LLMStreamingParams = LLMCallParams & {
  /** Conversation ID for the Realtime channel */
  conversationId: string;
  /** Unique request ID for this streaming call (used by browser to match deltas) */
  requestId: string;
};

export async function callLLMStreaming(params: LLMStreamingParams): Promise<LLMCallResult> {
  const log = createLogger("llm-stream", {
    u: params.userId.slice(0, 8),
    conv: params.conversationId.slice(0, 8),
    req: params.requestId.slice(0, 12),
  });

  // Temporal activity context. We use this to wire the activity's
  // cancellation signal into `streamText`'s AbortSignal, so that a
  // chatCancelSignal on the workflow cancels the scope → Temporal delivers
  // the cancellation to this activity on its next heartbeat → the AbortSignal
  // aborts the underlying fetch → the fullStream for-await loop throws →
  // we catch it and finalize the partial message as "cancelled". Without
  // this, a cancelled generation ran to the full 5-minute startToClose
  // timeout and burned tokens the user thought they had stopped.
  const ctx = Context.current();

  // Interceptor check — delegate/synthetic bypass streaming
  const { interceptLLMCall, callLLM } = await import("./llm.js");
  const decision = interceptLLMCall(params);
  if (decision.action === "synthetic") return decision.result;
  if (decision.action === "delegate") return callLLM(params);

  // Setup Supabase Realtime for broadcasting
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
  if (supabaseUrl && serviceKey) {
    const supabase = createClient(supabaseUrl, serviceKey);
    channel = supabase.channel(`guardian:chat:${params.conversationId}`);
    await new Promise<void>((resolve) => {
      channel!.subscribe((status) => {
        if (status === "SUBSCRIBED") resolve();
      });
      // Fallback: don't block forever if subscription fails
      setTimeout(resolve, 3000);
    });
  }

  // Resolve model
  const { resolveModelForActivity } = await import("./llm-resolver.js");
  const { streamText, jsonSchema, wrapLanguageModel, extractReasoningMiddleware } = await import("ai");
  const resolved = await resolveModelForActivity(params.userId, params.model, params.purpose);

  // Reasoning middleware for non-reasoning models
  const { modelSupportsReasoning } = await import("./llm.js");
  const hasNativeReasoning = await modelSupportsReasoning(resolved.modelId);
  const model = hasNativeReasoning
    ? resolved.model
    : wrapLanguageModel({
        model: resolved.model as Parameters<typeof wrapLanguageModel>[0]["model"],
        middleware: extractReasoningMiddleware({ tagName: "thinking" }),
      });

  // Build tool set
  const toolSet = params.tools
    ? Object.fromEntries(
        params.tools.map((t) => [
          t.name,
          {
            description: t.description,
            inputSchema: jsonSchema(t.parameters, {
              validate: (value: unknown) => ({ success: true as const, value }),
            }),
          },
        ])
      )
    : undefined;

  // Inject <thinking> instruction for non-reasoning models
  const messages = [...params.messages];
  if (!hasNativeReasoning) {
    const systemIdx = messages.findIndex((m) => m.role === "system");
    if (systemIdx !== -1) {
      messages[systemIdx] = {
        ...messages[systemIdx],
        content: messages[systemIdx].content +
          "\n\n## THINKING PROCESS\nWhile you work, emit your reasoning inside <thinking>...</thinking> blocks.\nKeep thinking blocks short (1-2 sentences).",
      };
    }
  }

  // Convert messages to AI SDK ModelMessage format (structured tool calls, not flattened text)
  const aiMessages: Array<
    | { role: "system"; content: string }
    | { role: "user"; content: string | Array<{ type: "text"; text: string } | { type: "image"; image: string }> }
    | { role: "assistant"; content: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> }> }
    | { role: "tool"; content: Array<{ type: "tool-result"; toolCallId: string; toolName: string; result: string; isError?: boolean }> }
  > = [];

  // Build a map of toolCallId -> toolName for tool result messages
  const toolCallNames = new Map<string, string>();
  for (const m of messages) {
    if (m.toolCalls) {
      for (const tc of m.toolCalls) toolCallNames.set(tc.id, tc.name);
    }
  }

  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      // Structured assistant message with tool calls (AI SDK native format)
      const parts: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> }> = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        parts.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, input: tc.arguments });
      }
      aiMessages.push({ role: "assistant", content: parts });
      continue;
    }

    if (m.role === "tool") {
      // Structured tool result (AI SDK v6 ModelMessage format)
      const tcId = m.toolCallId ?? "unknown";
      aiMessages.push({
        role: "tool",
        // AI SDK v6 Zod schema expects { output: { type: "text", value } } but TS types say { result }.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        content: [{ type: "tool-result", toolCallId: tcId, toolName: toolCallNames.get(tcId) ?? "unknown", output: { type: "text", value: m.content } } as any],
      });
      continue;
    }

    if (m.images?.length && m.role === "user") {
      const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [
        { type: "text", text: m.content },
      ];
      for (const img of m.images) parts.push({ type: "image", image: img });
      aiMessages.push({ role: "user", content: parts });
      continue;
    }

    if (m.role === "system") {
      aiMessages.push({ role: "system", content: m.content });
    } else if (m.role === "user") {
      aiMessages.push({ role: "user", content: m.content });
    } else {
      aiMessages.push({ role: "assistant", content: [{ type: "text", text: m.content }] });
    }
  }

  const benchmarkStart = Date.now();
  const toolCount = toolSet ? Object.keys(toolSet).length : 0;
  log.info("starting streaming LLM call [v2-snapshots]", { model: resolved.modelId, msgCount: aiMessages.length, toolCount });
  if (toolSet && toolCount > 0) {
    log.info("tool catalog", { names: Object.keys(toolSet).join(", ") });
  }
  // Diagnostic: log message shape (role + lengths) for multi-turn calls.
  // Never dump message content — it persists in worker stdout (Railway logs).
  if (aiMessages.length > 3) {
    for (let i = 3; i < aiMessages.length; i++) {
      log.info(`msg[${i}] shape`, redactMessage(aiMessages[i]));
    }
  }

  // Stream the LLM call.
  //
  // `abortSignal` is wired to a combined controller that aborts when EITHER:
  //   1. Temporal cancellation (user Stop click) fires ctx.cancellationSignal
  //   2. First-token timeout fires (no token received within 60s)
  // This ensures the stream doesn't hang forever on unresponsive providers.
  // Combine three abort sources into one signal:
  //   1. Temporal cancellation (user Stop)
  //   2. First-token timeout (model unresponsive)
  // AbortSignal.any() merges them — whichever fires first aborts the fetch.
  const timeoutSignal = AbortSignal.timeout(FIRST_TOKEN_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([ctx.cancellationSignal, timeoutSignal]);

  const result = streamText({
    model,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: aiMessages as any,
    maxOutputTokens: params.maxTokens ?? 4096,
    tools: toolSet,
    abortSignal: combinedSignal,
  });

  // Collect the full response while broadcasting deltas
  let fullText = "";
  let fullReasoning = "";
  let lastBroadcastAt = 0;
  let textBuffer = "";
  let reasoningBuffer = "";
  let firstTokenAt = 0;
  let tokenCount = 0;
  let lastSnapshotAt = 0;
  let snapshotMessageId: string | null = null;

  // Create a Supabase client for periodic DB snapshots (F5 recovery)
  const snapshotSupabase = (supabaseUrl && serviceKey)
    ? createClient(supabaseUrl, serviceKey)
    : null;

  // Pre-create the assistant message row so F5 can find partial text
  if (snapshotSupabase) {
    const { data } = await snapshotSupabase
      .from("messages")
      .insert({
        conversation_id: params.conversationId,
        role: "assistant",
        content: "",
        parts: [{ type: "text", text: "", state: "streaming" }],
        metadata: { streaming: true, requestId: params.requestId },
      })
      .select("id")
      .single();
    if (data) {
      snapshotMessageId = data.id;
      log.info("pre-created streaming message", { msgId: snapshotMessageId });
    }
  }

  // Heartbeat interval to keep the activity alive
  const heartbeatTimer = setInterval(() => {
    heartbeat({ textLength: fullText.length, reasoningLength: fullReasoning.length });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    // Iterate fullStream to catch ALL events including API errors.
    // We handle text-delta, reasoning, tool-call, error, and finish events.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let streamToolCalls: any[] = [];
    for await (const part of result.fullStream) {
      if (part.type === "error") {
        const errObj = part.error as Error & { value?: unknown };
        let apiMsg = errObj?.message ?? String(part.error);
        if (errObj?.value && typeof errObj.value === "object") {
          const val = errObj.value as { error?: string; code?: string };
          if (val.error) apiMsg = val.error;
        }
        throw new Error(apiMsg);
      }
      if (part.type === "reasoning-delta") {
        fullReasoning += (part as { text?: string }).text ?? "";
        continue;
      }
      if (part.type === "tool-call") {
        streamToolCalls.push(part);
        continue;
      }
      if (part.type === "text-delta") {
        const chunk = part.text;
        if (!firstTokenAt) firstTokenAt = Date.now();
        tokenCount++;
        fullText += chunk;
        textBuffer += chunk;

        const now = Date.now();
        if (channel && now - lastBroadcastAt >= BROADCAST_BUFFER_MS) {
          lastBroadcastAt = now;
          channel.send({
            type: "broadcast",
            event: "text_delta",
            payload: { requestId: params.requestId, content: textBuffer },
          }).catch(() => {}); // Non-fatal
          textBuffer = "";
        }

        // Periodic DB snapshot + Realtime snapshot for F5 recovery
        if (now - lastSnapshotAt >= DB_SNAPSHOT_INTERVAL_MS) {
          lastSnapshotAt = now;
          log.info("DB snapshot", { msgId: snapshotMessageId, textLen: fullText.length });
          if (snapshotSupabase && snapshotMessageId) {
            snapshotSupabase
              .from("messages")
              .update({
                content: fullText,
                parts: [{ type: "text", text: fullText, state: "streaming" }],
              })
              .eq("id", snapshotMessageId)
              .then(() => {});
          }
          if (channel) {
            channel.send({
              type: "broadcast",
              event: "text_snapshot",
              payload: { requestId: params.requestId, content: fullText },
            }).catch(() => {});
          }
        }
      } // end text-delta
    } // end fullStream loop

    // Flush remaining text buffer
    if (channel && textBuffer) {
      channel.send({
        type: "broadcast",
        event: "text_delta",
        payload: { requestId: params.requestId, content: textBuffer },
      }).catch(() => {});
    }

    // Use values collected from the fullStream loop (reasoning + tool calls).
    // Usage is still awaited from the result since it comes with the finish event.
    const toolCalls = streamToolCalls.length > 0 ? streamToolCalls : null;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    try {
      usage = await Promise.race([
        result.usage,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000)),
      ]);
    } catch { /* non-fatal */ }

    // Collect finishReason from the streamText result. Same race pattern as usage
    // since it's settled when the finish event fires. Enables downstream UI to
    // distinguish "stop" (normal), "length" (truncation), "tool-calls", etc.
    let finishReason: string | undefined;
    try {
      const fr = await Promise.race([
        result.finishReason,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000)),
      ]);
      if (typeof fr === "string") finishReason = fr;
    } catch { /* non-fatal */ }

    // ── Free tier usage tracking ──────────────────────────────────────────
    // When the user is on the included free tier (platform AI Gateway key),
    // log token counts + computed $ cost into user_usage_log so quotas can
    // be enforced and the Account > Usage page stays in sync. Fire-and-forget
    // — never block the streaming response on billing bookkeeping. Cost
    // computation mirrors the legacy `/api/chat` route: look up the model's
    // per-token pricing in `model_pricing_cache` and multiply by the actual
    // token counts returned by the provider.
    if (resolved.isFreeTier && usage && snapshotSupabase) {
      const inputTokens = (usage as { inputTokens?: number }).inputTokens ?? 0;
      const outputTokens = (usage as { outputTokens?: number }).outputTokens ?? 0;
      if (inputTokens > 0 || outputTokens > 0) {
        // Fire-and-forget pricing lookup + RPC — any error is logged but
        // never bubbles up to the user.
        void (async () => {
          try {
            const pricing = await lookupModelPricing(snapshotSupabase, resolved.modelId);
            const costInput = inputTokens * pricing.inputPerToken;
            const costOutput = outputTokens * pricing.outputPerToken;
            const { error: rpcError } = await snapshotSupabase.rpc("increment_usage", {
              p_user_id: params.userId,
              p_input_tokens: inputTokens,
              p_output_tokens: outputTokens,
              p_model: resolved.modelId,
              p_cost_input: costInput,
              p_cost_output: costOutput,
            });
            if (rpcError) {
              log.warn("increment_usage failed", { error: rpcError.message });
            }
          } catch (trackErr) {
            log.warn("usage tracking failed", { error: String(trackErr) });
          }
        })();
      }
    }

    // fullReasoning already collected from the fullStream loop (reasoning events)

    // Broadcast tool calls if any
    if (channel && toolCalls?.length) {
      for (const tc of toolCalls) {
        channel.send({
          type: "broadcast",
          event: "tool_call_start",
          payload: {
            requestId: params.requestId,
            toolName: (tc as Record<string, unknown>).toolName as string,
            toolCallId: (tc as Record<string, unknown>).toolCallId as string,
            args: ((tc as Record<string, unknown>).args ?? (tc as Record<string, unknown>).input ?? {}) as Record<string, unknown>,
          },
        }).catch(() => {});
      }
    }

    // Detect empty response (0 tokens, 0 tool calls) — always an error.
    // The AI SDK throws TypeValidationError async from its internal SSE parser.
    // We surface the real error by awaiting result.text (which forces full resolution).
    if (tokenCount === 0 && !toolCalls?.length) {
      // Empty response with no errors caught by fullStream — use fallback message
      throw new Error("LLM returned an empty response (0 tokens, 0 tool calls). The model may be at capacity.");
    }

    // Final DB snapshot — mark message as complete
    if (snapshotSupabase && snapshotMessageId) {
      if (toolCalls?.length) {
        // LLM returned tool calls AND possibly some text. The workflow will
        // persist one assistant message per tool call afterwards (with a
        // dynamic-tool part). For the pre-tool-call text:
        //   - If it's non-trivial, keep it as a standalone text message so
        //     the user sees reasoning like "Je vais vérifier ta sélection…"
        //     or "Je vois que tu as sélectionné Rond Bleu…" alongside the
        //     tool-call bubble. Trimming prevents pure whitespace leaks.
        //   - If it's empty/short (e.g. just "✅" or ""), drop it — the
        //     tool-call bubble alone carries the semantic content.
        const meaningful = fullText.trim().length > 4;
        if (meaningful) {
          await snapshotSupabase
            .from("messages")
            .update({
              content: fullText,
              parts: [
                ...(fullReasoning ? [{ type: "reasoning", text: fullReasoning, state: "done" }] : []),
                { type: "text", text: fullText, state: "done" },
              ],
              metadata: {
                model: resolved.modelId,
                reasoning: fullReasoning || undefined,
                usage: usage ?? undefined,
                finishReason: finishReason ?? undefined,
                streaming: false,
              },
            })
            .eq("id", snapshotMessageId);
          log.info("kept intermediate message (has meaningful text + tool calls)", {
            msgId: snapshotMessageId, textLen: fullText.length, toolCallCount: toolCalls.length,
          });
        } else {
          await snapshotSupabase
            .from("messages")
            .delete()
            .eq("id", snapshotMessageId);
          log.info("deleted intermediate message (tool calls, no meaningful text)", { msgId: snapshotMessageId });
        }
      } else {
        await snapshotSupabase
          .from("messages")
          .update({
            content: fullText,
            parts: [
              ...(fullReasoning ? [{ type: "reasoning", text: fullReasoning, state: "done" }] : []),
              { type: "text", text: fullText, state: "done" },
            ],
            metadata: {
              model: resolved.modelId,
              reasoning: fullReasoning || undefined,
              usage: usage ?? undefined,
              finishReason: finishReason ?? undefined,
              streaming: false,
            },
          })
          .eq("id", snapshotMessageId);
        log.info("finalized streaming message", { msgId: snapshotMessageId, finishReason });
      }
    }

    // Broadcast completion
    if (channel) {
      channel.send({
        type: "broadcast",
        event: "text_complete",
        payload: {
          requestId: params.requestId,
          content: fullText,
          modelId: resolved.modelId,
          reasoning: fullReasoning || undefined,
          usage: usage ?? undefined,
          finishReason: finishReason ?? undefined,
          hasToolCalls: !!(toolCalls?.length),
        },
      }).catch(() => {});
    }

    const { getMetadataFormat } = await import("./llm.js");
    const metadataFormat = await getMetadataFormat(resolved.modelId);

    const benchmarkEnd = Date.now();
    const ttft = firstTokenAt ? firstTokenAt - benchmarkStart : -1;
    const totalMs = benchmarkEnd - benchmarkStart;
    const tokPerSec = totalMs > 0 ? Math.round((tokenCount / totalMs) * 1000) : 0;
    log.info("streaming completed", {
      model: resolved.modelId,
      textLen: fullText.length,
      reasoningLen: fullReasoning.length,
      toolCalls: toolCalls?.length ?? 0,
      ttft,
      totalMs,
      tokenCount,
      tokPerSec,
    });

    return {
      content: fullText,
      reasoning: fullReasoning || undefined,
      reasoningSimulated: !hasNativeReasoning && !!fullReasoning,
      modelId: resolved.modelId,
      metadataFormat,
      finishReason,
      toolCalls: toolCalls?.map((tc: Record<string, unknown>) => {
        const args = (tc.args ?? tc.input ?? {}) as Record<string, unknown>;
        return { id: tc.toolCallId as string, name: tc.toolName as string, arguments: args };
      }),
      usage: usage
        ? {
            promptTokens: (usage as { inputTokens?: number }).inputTokens ?? 0,
            completionTokens: (usage as { outputTokens?: number }).outputTokens ?? 0,
            totalTokens:
              ((usage as { inputTokens?: number }).inputTokens ?? 0) +
              ((usage as { outputTokens?: number }).outputTokens ?? 0),
          }
        : undefined,
    };
  } catch (streamErr) {
    const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);

    // ── Cancellation path ─────────────────────────────────────────────────
    // If the activity was cancelled mid-stream (user clicked Stop), the
    // underlying fetch was aborted by ctx.cancellationSignal, which makes
    // streamText throw. We finalize whatever text had accumulated so far as
    // the assistant's final message (finishReason = "cancelled") instead of
    // deleting it — the user still wants to see what they stopped, and the
    // message must be in the history for the next turn to make sense.
    if (ctx.cancellationSignal.aborted) {
      log.info("stream cancelled by user", { textLen: fullText.length, reasoningLen: fullReasoning.length });

      // Use the actual resolved modelId if available. `params.model` may be
      // undefined for free-tier users since the model is resolved inside the
      // activity (resolveModelForActivity); in that case fall back to
      // whatever we have. If cancellation fires BEFORE resolution completes,
      // `resolved` is undefined — that's OK, we just persist without a
      // modelId in metadata.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolvedModelId = (typeof resolved !== "undefined" ? (resolved as any)?.modelId : undefined) ?? params.model;

      // Finalize the pre-created streaming message with whatever was produced
      // up to the cancellation point. Mirror the happy-path shape so the UI
      // renders it as a normal (if truncated) assistant turn.
      if (snapshotSupabase && snapshotMessageId) {
        try {
          await snapshotSupabase
            .from("messages")
            .update({
              content: fullText,
              parts: [
                ...(fullReasoning ? [{ type: "reasoning", text: fullReasoning, state: "done" }] : []),
                { type: "text", text: fullText, state: "done" },
              ],
              metadata: {
                model: resolvedModelId,
                reasoning: fullReasoning || undefined,
                finishReason: "cancelled",
                streaming: false,
              },
            })
            .eq("id", snapshotMessageId);
        } catch { /* non-fatal — message may be incomplete but workflow continues */ }
      }

      // Broadcast a synthetic text_complete so the client flips out of
      // streaming state (instead of waiting forever for text_complete that
      // will never arrive because the activity is dying).
      if (channel) {
        try {
          await channel.send({
            type: "broadcast",
            event: "text_complete",
            payload: {
              requestId: params.requestId,
              content: fullText,
              modelId: resolvedModelId,
              reasoning: fullReasoning || undefined,
              finishReason: "cancelled",
              hasToolCalls: false,
            },
          });
        } catch { /* non-fatal */ }
      }

      // Throw a CancelledFailure (NOT the underlying stream abort error)
      // so that the workflow's `isCancellation(err)` helper recognizes this
      // as a cancellation and routes the catch into the clean-idle branch.
      // If we re-threw `streamErr` (a regular AbortError from fetch), it
      // would be wrapped as an ActivityFailure by Temporal and
      // `isCancellation()` would return false, causing the workflow to mark
      // itself as errored instead of returning to idle for a follow-up.
      throw new CancelledFailure("Chat generation cancelled by user");
    }

    // ── Error path (non-cancel) ───────────────────────────────────────────
    log.error("streaming LLM call failed", { error: errMsg });

    // Clean up the pre-created empty message (otherwise it shows as blank in the UI)
    if (snapshotSupabase && snapshotMessageId) {
      try {
        await snapshotSupabase
          .from("messages")
          .delete()
          .eq("id", snapshotMessageId);
      } catch { /* non-fatal */ }
    }

    // Broadcast the error so the frontend can display it immediately
    if (channel) {
      log.info("broadcasting stream_error to frontend", { requestId: params.requestId });
      try {
        await channel.send({
          type: "broadcast",
          event: "stream_error",
          payload: { requestId: params.requestId, error: errMsg },
        });
        log.info("stream_error broadcast sent");
      } catch (broadcastErr) {
        log.error("stream_error broadcast failed", { error: String(broadcastErr) });
      }
    } else {
      log.warn("no channel available for stream_error broadcast");
    }

    // Re-throw so the workflow's catch block can persist the error message
    throw streamErr;
  } finally {
    clearInterval(heartbeatTimer);
    if (channel) {
      channel.unsubscribe();
    }
  }
}

/** Try to parse a string as JSON; return the original string if it fails. */
function tryParseJSON(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

// ---------------------------------------------------------------------------
// Model pricing lookup (inline, activity-scope)
// ---------------------------------------------------------------------------
//
// The web package has a richer `getModelPricing` in `lib/model-pricing.ts`
// with in-memory cache + Supabase fallback + hardcoded defaults. Duplicating
// that module here would require a cross-package refactor (move to
// @guardian/orchestrations), which was out of scope for the April 2026 audit
// pass. Instead we keep a minimal lookup that hits the same
// `model_pricing_cache` table and falls back to zero cost when the model
// isn't priced — tokens are still tracked, only the $ attribution is missing.

type ActivityPricing = { inputPerToken: number; outputPerToken: number };

/**
 * Minimal activity-side pricing lookup against the `model_pricing_cache`
 * Supabase table. No caching — called at most once per free-tier LLM call,
 * and the RPC that follows it is already fire-and-forget, so the extra
 * round-trip is acceptable for cost tracking accuracy.
 */
async function lookupModelPricing(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  modelId: string,
): Promise<ActivityPricing> {
  try {
    const { data, error } = await supabase
      .from("model_pricing_cache")
      .select("input_per_token, output_per_token")
      .eq("model_id", modelId)
      .maybeSingle();

    if (!error && data) {
      return {
        inputPerToken: Number(data.input_per_token) || 0,
        outputPerToken: Number(data.output_per_token) || 0,
      };
    }
  } catch {
    /* fall through to zero-cost */
  }
  return { inputPerToken: 0, outputPerToken: 0 };
}
