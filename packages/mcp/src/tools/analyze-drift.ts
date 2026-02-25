import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { PLAYBOOKS } from "../guardian/playbooks.js"

export function registerAnalyzeDriftTool(server: McpServer): void {
  server.tool(
    "guardian_analyze_drift",
    `Use this when a component looks different from its DS master, when local token
overrides are detected, or when a Figma node appears detached.

If customTokens are provided (hardcoded values found on the node), they are treated
as confirmed drift signals and the investigation focuses on measuring their scope.

Returns a structured investigation plan: steps to compare the node against its DS
master, what token overrides to look for, and how to interpret findings.

Do NOT use this for discovering if a component exists — use guardian_check_component_usage.
Do NOT use this for assessing uniqueness — use guardian_assess_snowflake.`,
    {
      componentName: z.string().min(1).describe(
        "Name of the component suspected of drifting (e.g. 'Button', 'Card')"
      ),
      figmaNodeId: z.string().optional().describe(
        "Figma node ID of the specific element to compare against its master"
      ),
      customTokens: z.record(z.string()).optional().describe(
        "Hardcoded values already detected on the node (e.g. { 'color': '#FF0000' }). " +
        "Providing these confirms drift and focuses the investigation on scope."
      ),
      currentFile: z.string().optional().describe(
        "Current file path in the codebase if the question comes from a code editor"
      ),
    },
    async ({ componentName, figmaNodeId, customTokens, currentFile }) => {
      const playbook = PLAYBOOKS.drift_detection
      const confirmed = customTokens && Object.keys(customTokens).length > 0

      const steps = playbook.steps
        .filter((step) => {
          // Skip the figma comparison step if no nodeId provided
          if (step.id === "dd-2" && !figmaNodeId) return false
          // Skip the code file step if no currentFile provided
          if (step.id === "dd-4" && !currentFile) return false
          return true
        })
        .map((step) => ({
          ...step,
          suggested_query: step.suggested_query
            .replaceAll("{componentName}", componentName)
            .replaceAll("{figmaNodeId}", figmaNodeId ?? "<figma-node-id>")
            .replaceAll("{currentFile}", currentFile ?? "<current-file>"),
          what_to_look_for: step.what_to_look_for.map((item) =>
            item
              .replaceAll("{componentName}", componentName)
              .replaceAll("{figmaNodeId}", figmaNodeId ?? "<figma-node-id>")
          ),
        }))

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                tool: "guardian_analyze_drift",
                component: componentName,
                figmaNodeId: figmaNodeId ?? null,
                confirmedDrift: confirmed
                  ? { detectedTokens: customTokens }
                  : null,
                investigation_plan: {
                  summary: confirmed
                    ? `Drift confirmed (${Object.keys(customTokens!).length} hardcoded value(s)). Investigate scope and impact.`
                    : playbook.summary_template.replaceAll("{componentName}", componentName),
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
