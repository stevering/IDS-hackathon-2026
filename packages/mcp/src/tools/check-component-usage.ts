import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { PLAYBOOKS } from "../guardian/playbooks.js"
import { formatToolResponse } from "../lib/format-response.js"

export function registerCheckComponentUsageTool(server: McpServer): void {
  server.tool(
    "check_component_usage",
    `Use this BEFORE creating any custom component or variant.

Checks if a component already exists in the design system (Figma library + codebase).
Returns a structured investigation plan: which MCP tools to call, what to search for,
and how to interpret results.

Do NOT use this for drift detection (use analyze_drift instead).
Do NOT use this if the component clearly does not exist — use assess_snowflake.`,
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

      const data = {
        tool: "check_component_usage",
        component: componentName,
        domain: domain ?? "general",
        investigation_plan: {
          summary: playbook.summary_template,
          priority: playbook.priority,
          steps,
        },
        drift_signals: playbook.drift_signals,
        interpretation_guide: playbook.interpretation_guide,
      }

      const summary =
        `Investigation plan ready for "${componentName}" (domain: ${domain ?? "general"}, priority: ${playbook.priority}). ` +
        `${steps.length} step(s) to verify if this component already exists in the design system. ` +
        `Start with step "${steps[0]?.goal ?? "unknown"}".`

      return formatToolResponse(summary, data)
    }
  )
}
