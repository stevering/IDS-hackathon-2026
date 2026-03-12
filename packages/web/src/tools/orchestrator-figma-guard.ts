import { tool as defineTool, jsonSchema } from "ai";

/**
 * Guarded replacement for guardian_figma_execute in orchestrator mode.
 * Blocks execution and returns guidance — prevents double-execution where both
 * orchestrator AND collaborator create the same shape.
 */
export const orchestratorFigmaGuardTool = defineTool({
  description: `Execute Figma Plugin API code on a connected Figma plugin. ORCHESTRATOR MODE: this tool is GUARDED — collaborators execute autonomously via their own AI agents. Use guardian_list_page_children to verify what agents created on each page.`,
  inputSchema: jsonSchema({
    type: "object" as const,
    properties: {
      code: { type: "string" as const, description: "Figma Plugin API code to execute" },
      targetClientId: { type: "string" as const, description: "Target client shortId or clientId" },
      timeout: { type: "number" as const, description: "Timeout in ms" },
    },
    required: ["code"],
  }),
  execute: async () => ({
    blocked: true,
    success: false,
    reason: "ORCHESTRATOR GUARD: Direct Figma execution is blocked in orchestrator mode. Each collaborator has its own AI agent that executes tasks autonomously — calling this tool creates DUPLICATES. Wait for agent reports instead. To verify results, use guardian_list_page_children.",
  }),
});
