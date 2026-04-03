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

  // Convert messages to AI SDK format (same as callLLMDirect)
  const aiMessages = messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      const toolSummary = m.toolCalls
        .map((tc) => `[Called tool: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})]`)
        .join("\n");
      return { role: "assistant" as const, content: (m.content || "") + "\n" + toolSummary };
    }
    if (m.role === "tool") {
      if (m.images?.length) {
        const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [
          { type: "text", text: `[Tool result] ${m.content}` },
        ];
        for (const img of m.images) parts.push({ type: "image", image: img });
        return { role: "user" as const, content: parts };
      }
      return { role: "user" as const, content: `[Tool result] ${m.content}` };
    }
    if (m.images?.length && m.role === "user") {
      const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [
        { type: "text", text: m.content },
      ];
      for (const img of m.images) parts.push({ type: "image", image: img });
      return { role: "user" as const, content: parts };
    }
    return { role: m.role as "system" | "user" | "assistant", content: m.content };
  });

  const benchmarkStart = Date.now();
  log.info("starting streaming LLM call [v2-snapshots]", { model: resolved.modelId, msgCount: aiMessages.length, hasTools: !!toolSet });

  // Stream the LLM call
  const result = streamText({
    model,
    messages: aiMessages,
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
    // Stream text deltas
    const textStream = result.textStream;
    for await (const chunk of textStream) {
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
        // DB snapshot (fire-and-forget — .then() triggers the request)
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
        // Realtime snapshot — broadcast full accumulated text so F5 clients can catch up
        if (channel) {
          channel.send({
            type: "broadcast",
            event: "text_snapshot",
            payload: { requestId: params.requestId, content: fullText },
          }).catch(() => {});
        }
      }
    }

    // Flush remaining text buffer
    if (channel && textBuffer) {
      channel.send({
        type: "broadcast",
        event: "text_delta",
        payload: { requestId: params.requestId, content: textBuffer },
      }).catch(() => {});
    }

    // Await individual promise properties from the stream result
    const [reasoningText, toolCalls, usage] = await Promise.all([
      result.reasoningText,
      result.toolCalls,
      result.usage,
    ]);

    fullReasoning = reasoningText ?? "";

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
  } finally {
    clearInterval(heartbeatTimer);
    if (channel) {
      channel.unsubscribe();
    }
  }
}
