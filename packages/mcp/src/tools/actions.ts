import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { getAction, listActions, interpolate, validateParams } from "../actions/registry.js"
import { executeViaSupabase } from "../lib/figma-bridge.js"
import { formatToolResponse } from "../lib/format-response.js"

export function registerActionTools(server: McpServer, userId?: string): void {

  // -------------------------------------------------------------------------
  // list_actions
  // -------------------------------------------------------------------------
  server.tool(
    "list_actions",
    `List all available Guardian actions.

Actions are parameterized code templates that run via the Guardian plugin bridge.
They cover common DS compliance operations: inspecting nodes, detecting token
overrides, finding component masters, annotating drift, etc.

Call this before run_action to discover action names and their required params.
Filter by category to narrow results:
  - ds-inspection : read DS state (variables, components, fills)
  - ds-annotation : write annotations/markers on the canvas
  - variables     : create/update Figma variables (user-defined)
  - nodes         : manipulate node properties (user-defined)
  - components    : component/instance operations (user-defined)
  - user          : user-created custom actions`,
    {
      category: z.string().optional().describe(
        "Filter by action category: 'ds-inspection', 'ds-annotation', " +
        "'variables', 'nodes', 'components', 'user'"
      ),
    },
    async ({ category }) => {
      const actions = await listActions(category)
      const actionList = actions.map((a) => ({
        name: a.name,
        description: a.description,
        category: a.category,
        source: a.source,
        params: a.params.map((p) => ({
          name: p.name,
          type: p.type,
          required: p.required,
          description: p.description,
          ...(p.default !== undefined ? { default: p.default } : {}),
        })),
      }))

      const data = {
        total: actionList.length,
        category: category ?? "all",
        actions: actionList,
      }

      let summary: string
      if (actionList.length === 0) {
        summary = `No actions found${category ? ` in category "${category}"` : ``}.`
      } else {
        const names = actionList.map((a) => a.name)
        const displayNames = names.length > 10
          ? names.slice(0, 10).join(", ") + `, ... and ${names.length - 10} more`
          : names.join(", ")
        summary = `Found ${actionList.length} action(s)${category ? ` in category "${category}"` : ` across all categories`}: ${displayNames}.`
      }

      return formatToolResponse(summary, data)
    }
  )

  // -------------------------------------------------------------------------
  // run_action
  // -------------------------------------------------------------------------
  server.tool(
    "run_action",
    `Run a named Guardian action in Figma via the Guardian plugin bridge.

Actions are pre-validated Figma Plugin API code templates. Prefer this over
figma_execute for common DS operations — actions have tested, safe code.

Workflow:
  1. Call list_actions to see available actions and their params
  2. Call run_action with the action name and required params
  3. The action's code template is interpolated with your params
  4. The result is returned from the Figma plugin

IMPORTANT: The Guardian Figma plugin must be open in Figma Desktop.

Built-in actions for DS compliance:
  - get_selection_context   : snapshot of selected node(s)
  - get_node_variables      : variables bound to a node (requires nodeId)
  - detect_token_overrides  : find hardcoded non-token values (requires nodeId)
  - get_component_master    : master component of an instance (requires nodeId)
  - get_ds_variables        : list all local tokens in the file
  - annotate_drift          : add drift warning on canvas (requires nodeId)`,
    {
      name: z.string().min(1).describe(
        "Action name (from list_actions, e.g. 'get_selection_context')"
      ),
      params: z.record(z.unknown()).optional().describe(
        "Parameters for the action (see list_actions for required params per action)"
      ),
    },
    async ({ name, params }) => {
      const action = await getAction(name)
      if (!action) {
        return formatToolResponse(
          `Action "${name}" not found. Call list_actions to see available actions.`,
          { success: false, error: `Action '${name}' not found.` },
        )
      }

      const resolvedParams = params ?? {}
      const missing = validateParams(action, resolvedParams)
      if (missing.length > 0) {
        return formatToolResponse(
          `Action "${name}" cannot run: missing required parameter(s) ${missing.join(", ")}.`,
          { success: false, error: `Missing required params: ${missing.join(", ")}`, action: { name: action.name, params: action.params } },
        )
      }

      const interpolatedCode = interpolate(action, resolvedParams)

      const requestId = `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const result = await executeViaSupabase(interpolatedCode, requestId, 10_000, userId)

      const resultData = { ...result, action: name, params_resolved: resolvedParams }

      let summary: string
      if (!result.success) {
        summary = `Action "${name}" failed: ${result.error ?? "execution error"}.`
      } else {
        const clients = result.result ?? []
        const succeeded = clients.filter((r) => r.success).length
        summary = `Action "${name}" executed successfully on ${succeeded} plugin(s).`
        if (clients.length === 1 && clients[0].success && clients[0].result !== undefined) {
          const preview = JSON.stringify(clients[0].result)
          if (preview.length <= 200) {
            summary += ` Result: ${preview}`
          }
        }
      }

      return formatToolResponse(summary, resultData)
    }
  )
}
