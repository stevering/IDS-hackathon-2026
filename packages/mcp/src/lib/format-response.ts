/**
 * Format a tool response with a natural language summary followed by structured JSON.
 *
 * @param summary  Human-readable summary sentence(s) describing the result
 * @param data     Structured data object to include as JSON (optional)
 * @returns        MCP-compatible content array with a single text block
 */
export function formatToolResponse(
  summary: string,
  data?: unknown
): { content: { type: "text"; text: string }[] } {
  const text = data !== undefined
    ? `${summary}\n\n---\n${JSON.stringify(data, null, 2)}`
    : summary

  return {
    content: [{ type: "text" as const, text }],
  }
}
