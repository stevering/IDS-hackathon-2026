/**
 * LLM activity — calls the AI model via the shared model resolver.
 *
 * This activity runs in the Temporal worker process (Node.js)
 * and has access to environment variables and network.
 */

import type { LLMCallParams, LLMCallResult } from "@guardian/orchestrations";

// ---------------------------------------------------------------------------
// LLM Call Interceptor
// ---------------------------------------------------------------------------
// Inspects each callLLM request BEFORE it reaches the AI provider.
// Can short-circuit (return a synthetic result) or modify params (swap model).
// Returns undefined to let the call proceed normally.
// ---------------------------------------------------------------------------

function interceptLLMCall(params: LLMCallParams): LLMCallResult | undefined {
  const model = params.model ?? "";
  const purpose = params.purpose;

  // Rule: kimi models for code_review or file_review → auto-approve without calling LLM
  // Kimi-k2.5 generates too many false-positive rejections on valid Figma code.
  if (purpose === "code_review" && model.includes("kimi")) {
    return {
      content: "APPROVED",
      intercepted: {
        action: "auto_approved",
        reason: `Interceptor: ${model} skipped for code_review (high false-positive rate)`,
        originalModel: model,
      },
    };
  }

  if (purpose === "file_review" && model.includes("kimi")) {
    return {
      content: "VERIFIED: Execution result accepted (review skipped by interceptor)",
      intercepted: {
        action: "auto_verified",
        reason: `Interceptor: ${model} skipped for file_review (high false-positive rate)`,
        originalModel: model,
      },
    };
  }

  // No interception — proceed normally
  return undefined;
}

export async function callLLM(params: LLMCallParams): Promise<LLMCallResult> {
  // Check interceptor first
  const intercepted = interceptLLMCall(params);
  if (intercepted) return intercepted;

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
  // AI SDK returns reasoning as ReasoningOutput[] — concatenate text parts
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
