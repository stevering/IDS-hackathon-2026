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
import { heartbeat } from "@temporalio/activity";
import type { LLMCallParams, LLMCallResult } from "@guardian/orchestrations";
import { createLogger } from "../lib/log.js";

const HEARTBEAT_INTERVAL_MS = 5_000;
const BROADCAST_BUFFER_MS = 50; // Minimum interval between broadcasts to avoid flooding
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
  const resolved = await resolveModelForActivity(params.userId, params.model);

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
  // Debug: log full message structure for diagnosis
  if (aiMessages.length > 3) {
    // Only dump on multi-turn calls (where tool results are present)
    for (let i = 3; i < aiMessages.length; i++) {
      const m = aiMessages[i];
      log.info(`msg[${i}] dump`, { json: JSON.stringify(m).slice(0, 500) });
    }
  }

  // Stream the LLM call
  const result = streamText({
    model,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: aiMessages as any,
    maxOutputTokens: params.maxTokens ?? 4096,
    tools: toolSet,
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
        // When LLM returns tool calls, the text is just a preamble (e.g. "✅ Plugin connected! Tool: xxx").
        // Delete the pre-created message — the tool call will be persisted separately by the workflow.
        await snapshotSupabase
          .from("messages")
          .delete()
          .eq("id", snapshotMessageId);
        log.info("deleted intermediate message (has tool calls)", { msgId: snapshotMessageId });
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
              streaming: false,
            },
          })
          .eq("id", snapshotMessageId);
        log.info("finalized streaming message", { msgId: snapshotMessageId });
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
