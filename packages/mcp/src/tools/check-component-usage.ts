import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { PLAYBOOKS } from "../guardian/playbooks.js"

export function registerCheckComponentUsageTool(server: McpServer): void {
  server.tool(
    "guardian_check_component_usage",
    `Use this BEFORE creating any custom component or variant.

Checks if a component already exists in the design system (Figma library + codebase).
Returns a structured investigation plan: which MCP tools to call, what to search for,
and how to interpret results.

Do NOT use this for drift detection (use guardian_analyze_drift instead).
Do NOT use this if the component clearly does not exist — use guardian_assess_snowflake.`,
    {
      componentName: z.string().min(1).describe(
        "Name of the component to look for (e.g. 'Button', 'Card', 'InputField')"
      ),
      domain: z.enum(["figma", "code", "general"]).optional().describe(
        "Where the question originates: 'figma' from Figma plugin, 'code' from editor"
      ),
    },
    async ({ componentName, domain }) => {
      const playbook = PLAYBOOKS.component_usage
      const steps = playbook.steps.map((step) => ({
        ...step,
        suggested_query: step.suggested_query.replaceAll("{componentName}", componentName),
        what_to_look_for: step.what_to_look_for.map((item) =>
          item.replaceAll("{componentName}", componentName)
        ),
      }))

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                tool: "guardian_check_component_usage",
                component: componentName,
                domain: domain ?? "general",
                investigation_plan: {
                  summary: playbook.summary_template,
                  priority: playbook.priority,
                  steps,
                },
                drift_signals: playbook.drift_signals,
                interpretation_guide: playbook.interpretation_guide,
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )
}
