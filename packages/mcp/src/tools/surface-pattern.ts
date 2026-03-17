import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { PLAYBOOKS } from "../guardian/playbooks.js"
import { formatToolResponse } from "../lib/format-response.js"

export function registerSurfacePatternTool(server: McpServer): void {
  server.tool(
    "surface_pattern",
    `Use this when the same custom solution appears in multiple places (3+) and you
need to assess whether it has reached the maturity threshold for DS inclusion.

Returns a structured investigation plan: how to map all instances across teams and
repositories, measure implementation consistency, and assess readiness for
standardization.

Threshold signals:
- 3+ instances with consistent implementation → escalate to DS team
- Inconsistent implementations → standardize first, then propose
- Single team only → too early`,
    {
      componentName: z.string().min(1).describe(
        "Name or description of the repeating pattern (e.g. 'InlineAlert', 'StatusBadge')"
      ),
      estimatedInstances: z.number().optional().describe(
        "Approximate number of known instances across teams (helps prioritize investigation)"
      ),
    },
    async ({ componentName, estimatedInstances }) => {
      const playbook = PLAYBOOKS.pattern_recognition
      const steps = playbook.steps.map((step) => ({
        ...step,
        suggested_query: step.suggested_query.replaceAll("{componentName}", componentName),
        what_to_look_for: step.what_to_look_for.map((item) =>
          item.replaceAll("{componentName}", componentName)
        ),
      }))

      const escalation = estimatedInstances !== undefined && estimatedInstances >= 3

      const data = {
        tool: "surface_pattern",
        component: componentName,
        estimatedInstances: estimatedInstances ?? "unknown",
        escalationLikely: escalation,
        investigation_plan: {
          summary: playbook.summary_template,
          priority: playbook.priority,
          steps,
        },
        drift_signals: playbook.drift_signals,
        interpretation_guide: playbook.interpretation_guide,
      }

      const summary =
        `Pattern recognition plan ready for "${componentName}"` +
        (estimatedInstances !== undefined ? ` (~${estimatedInstances} known instance(s))` : ``) +
        `. ${steps.length} step(s) to map all instances and assess DS inclusion readiness.` +
        (escalation ? ` Estimated instances meet the escalation threshold (3+).` : ``)

      return formatToolResponse(summary, data)
    }
  )
}
