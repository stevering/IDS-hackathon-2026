import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { PLAYBOOKS } from "../guardian/playbooks.js"

export function registerAssessSnowflakeTool(server: McpServer): void {
  server.tool(
    "guardian_assess_snowflake",
    `Use this when a designer or developer has built something custom and you need
to assess whether it is a genuine product-specific edge case (true snowflake)
or whether it already exists elsewhere and should be reused or standardized.

Returns a structured investigation plan: how to search for similar patterns
across the codebase and Figma files, and how to interpret the results.

Key distinction:
- If it already exists in the DS → use guardian_check_component_usage instead
- If it may be drifting from the DS → use guardian_analyze_drift instead
- If it is genuinely new and you want to know if others built the same → use this tool`,
    {
      componentName: z.string().min(1).describe(
        "Name or description of the custom component or pattern (e.g. 'CustomDatePicker')"
      ),
      codeSnippet: z.string().optional().describe(
        "Short code snippet showing the custom implementation (JSX, CSS, etc.)"
      ),
      domain: z.string().optional().describe(
        "Origin context: 'figma', 'code', or 'general'"
      ),
    },
    async ({ componentName, codeSnippet, domain }) => {
      const playbook = PLAYBOOKS.snowflake_check
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
                tool: "guardian_assess_snowflake",
                component: componentName,
                domain: domain ?? "general",
                codeSnippetProvided: !!codeSnippet,
                investigation_plan: {
                  summary: playbook.summary_template.replaceAll("{componentName}", componentName),
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
