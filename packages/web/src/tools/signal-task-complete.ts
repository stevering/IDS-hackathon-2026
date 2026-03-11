import { tool as defineTool, jsonSchema } from "ai";

/**
 * Client-side tool for collaborator agents to signal task completion.
 * No `execute` function — handled by useChat onToolCall in page.tsx,
 * which calls sendAgentResponse("task", "completed", summary).
 */
export const signalTaskCompleteTool = defineTool({
  description: `Signal that your assigned task is complete. Call this tool ONCE when you have finished all work and verified the results. Provide a brief summary of what was accomplished. This immediately notifies the orchestrator that you are done — do NOT call this until all work is verified and complete.`,
  inputSchema: jsonSchema({
    type: "object" as const,
    properties: {
      summary: { type: "string" as const, description: "Brief summary of what was accomplished and any issues encountered" },
    },
    required: ["summary"],
  }),
  // No execute function → client-side tool, handled by useChat onToolCall
});
