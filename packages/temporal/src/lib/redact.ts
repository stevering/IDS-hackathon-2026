/**
 * PII redaction helpers for log statements.
 *
 * Goal: never write user/LLM conversation content to stdout/stderr (which
 * surfaces in Railway logs and Temporal Cloud workflow history). Log
 * structural metadata (sizes, key names, role, success flag) instead.
 *
 * The conversation content itself is persisted in the Supabase tables that
 * have RLS — that is the only place it should live.
 *
 * Usage:
 *   log.info("call result", redactResult(result));
 *   log.info("tool call", { tool, ...redactArgs(args) });
 */

const MAX_KEY_LIST = 8;

function safeByteLen(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return -1;
  }
}

function topLevelKeys(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return "";
  if (keys.length <= MAX_KEY_LIST) return keys.join(",");
  return `${keys.slice(0, MAX_KEY_LIST).join(",")},+${keys.length - MAX_KEY_LIST}`;
}

/**
 * Redact tool call arguments. Returns only the shape (key names + size),
 * never the values — args may contain Figma code, user prompts, etc.
 */
export function redactArgs(args: unknown): { argKeys: string; argSize: number } {
  return { argKeys: topLevelKeys(args), argSize: safeByteLen(args) };
}

/**
 * Redact a tool/MCP execution result. Captures success + size, no content.
 */
export function redactResult(result: unknown): {
  resultSize: number;
  resultKeys: string;
  resultIsError: boolean;
} {
  const isError =
    result !== null &&
    typeof result === "object" &&
    (result as { isError?: unknown }).isError === true;
  return {
    resultSize: safeByteLen(result),
    resultKeys: topLevelKeys(result),
    resultIsError: isError,
  };
}

/**
 * Redact a single chat message. Captures role + content length, no content.
 */
export function redactMessage(m: unknown): {
  role: string;
  contentLen: number;
  toolCallCount: number;
} {
  if (m === null || typeof m !== "object") {
    return { role: "unknown", contentLen: 0, toolCallCount: 0 };
  }
  const msg = m as {
    role?: unknown;
    content?: unknown;
    toolCalls?: unknown[];
    tool_calls?: unknown[];
  };
  const toolCalls = Array.isArray(msg.toolCalls)
    ? msg.toolCalls
    : Array.isArray(msg.tool_calls)
      ? msg.tool_calls
      : [];
  return {
    role: typeof msg.role === "string" ? msg.role : "unknown",
    contentLen: safeByteLen(msg.content),
    toolCallCount: toolCalls.length,
  };
}

/**
 * Redact a broadcast/event payload. Captures keys + size, no values.
 */
export function redactPayload(payload: unknown): {
  payloadKeys: string;
  payloadSize: number;
} {
  return { payloadKeys: topLevelKeys(payload), payloadSize: safeByteLen(payload) };
}
