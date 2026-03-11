import { tool as defineTool, jsonSchema } from "ai";

/**
 * Client-side tool for executing Figma Plugin API code directly via postMessage.
 * No `execute` function — handled by useChat onToolCall in page.tsx.
 */
export const figmaPluginExecuteTool = defineTool({
  description: `Execute Figma Plugin API code directly on the local Figma plugin. The code runs in the plugin sandbox with access to the full Figma Plugin API.

CRITICAL RULES:
- Keep code SHORT (under 40 lines). Split large operations into multiple calls.
- Do ONE thing per call: create a node, set properties, add text, etc.
- Store node IDs from return values and reference them in subsequent calls.
- NEVER generate very long code blocks — they get truncated and cause syntax errors.
- The code body is wrapped in an async IIFE automatically — just write the body directly.
- Return a value to get it back as the result.`,
  inputSchema: jsonSchema({
    type: "object" as const,
    properties: {
      code: { type: "string" as const, description: "JavaScript code to execute in the Figma plugin sandbox. Has access to the full Figma Plugin API." },
      timeout: { type: "number" as const, description: "Timeout in milliseconds (default: 10000)" },
    },
    required: ["code"],
  }),
  // No execute function → client-side tool, handled by useChat onToolCall
});
