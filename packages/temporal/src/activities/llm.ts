/**
 * LLM activity — calls the AI model via the shared model resolver.
 *
 * This activity runs in the Temporal worker process (Node.js)
 * and has access to environment variables and network.
 */

import type { LLMCallParams, LLMCallResult } from "@guardian/orchestrations";

export async function callLLM(params: LLMCallParams): Promise<LLMCallResult> {
  // Dynamic import to avoid bundling issues with Temporal's workflow sandbox
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

  // Build a lookup of toolCallId → toolName from assistant messages
  const toolCallNameMap = new Map<string, string>();
  for (const m of params.messages) {
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        toolCallNameMap.set(tc.id, tc.name);
      }
    }
  }

  // Convert our LLMMessage[] to AI SDK ModelMessage[] format
  const messages = params.messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        content: [{
          type: "tool-result" as const,
          toolCallId: m.toolCallId!,
          toolName: toolCallNameMap.get(m.toolCallId!) ?? "unknown",
          result: m.content,
        }],
      };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant" as const,
        content: [
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
          ...m.toolCalls.map((tc) => ({
            type: "tool-call" as const,
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.arguments,
          })),
        ],
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

  return {
    content: result.text,
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
