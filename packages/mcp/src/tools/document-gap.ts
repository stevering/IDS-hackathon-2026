import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { PLAYBOOKS } from "../guardian/playbooks.js"

export function registerDocumentGapTool(server: McpServer): void {
  server.tool(
    "guardian_document_gap",
    `Use this when a DS component exists but is missing a specific variant, property,
or token that multiple teams need — and you want to build the case for a formal
DS extension request.

Returns a structured investigation plan: how to document the exact gap, find
evidence of it affecting other teams, and frame the request for the DS team.

Escalation threshold: gap affects 2+ teams, OR fix is a simple variant addition.`,
    {
      componentName: z.string().min(1).describe(
        "DS component that exists but is missing something (e.g. 'Button', 'Alert')"
      ),
      missingVariant: z.string().optional().describe(
        "The specific variant or property that is missing (e.g. 'size=xs', 'type=warning')"
      ),
      domain: z.string().optional().describe(
        "Origin context: 'figma', 'code', or 'general'"
      ),
    },
    async ({ componentName, missingVariant, domain }) => {
      const playbook = PLAYBOOKS.governance_request
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
                tool: "guardian_document_gap",
                component: componentName,
                missingVariant: missingVariant ?? null,
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
