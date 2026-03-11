/**
 * Guardian Actions — type definitions
 *
 * An action is a named, parameterized code template executed on a target runtime.
 * Actions decouple the MCP tool interface from the target implementation:
 *   - guardian_run_action("get_node_variables", { nodeId: "123:456" })
 *   - The action's template is interpolated with params, then sent to
 *     the appropriate target (e.g. Figma plugin bridge via guardian_figma_execute)
 *
 * Actions can be:
 *   - "builtin"  : shipped with Guardian, focused on DS compliance use cases
 *   - "user"     : created by the user, stored as JSON in mcp/actions/user/
 *
 * Southleft Figma Console compatibility is optional:
 *   a user can create actions like "create_variable", "set_node_fill", etc.
 *   by writing the corresponding Plugin API code template.
 */

export type ActionTarget = "figma" | "browser" | "api"

export type ActionCategory =
  | "ds-inspection"  // Read DS state: variables, components, tokens
  | "ds-annotation"  // Write annotations, flags, markers on canvas
  | "variables"      // CRUD on Figma variables/tokens
  | "nodes"          // Node manipulation (fills, strokes, opacity, etc.)
  | "components"     // Component/instance operations
  | "user"           // User-defined actions

export type ActionParamType = "string" | "number" | "boolean" | "object" | "array"

export type ActionParam = {
  name: string
  type: ActionParamType
  required: boolean
  description: string
  default?: unknown
}

export type Action = {
  name: string
  description: string
  category: ActionCategory
  params: ActionParam[]
  /**
   * Code template for the target runtime.
   * Use {{paramName}} for interpolation.
   * For Figma targets, the code runs inside an async IIFE in the plugin sandbox.
   * Must return a serializable value (or nothing).
   *
   * Example:
   *   "const node = await figma.getNodeByIdAsync('{{nodeId}}');
   *    return node ? { id: node.id, name: node.name } : null;"
   */
  template: string
  target?: ActionTarget
  source: "builtin" | "user"
  version: string
}

export type ActionRunResult = {
  success: boolean
  result: unknown
  action: string
  error?: string
}
