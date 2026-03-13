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

  // Convert our LLMMessage[] to AI SDK format.
  // Tool-call/tool-result messages are flattened to text so that
  // ALL providers (Kimi, xAI, OpenAI, etc.) handle them correctly.
  // The internal AI SDK model-message format for tool results uses
  // a specific schema that not all providers translate properly.
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
      return {
        role: "user" as const,
        content: `[Tool result] ${m.content}`,
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
