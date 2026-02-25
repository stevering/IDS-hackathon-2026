/**
 * Guardian Skills — type definitions
 *
 * A skill is a named, parameterized Figma Plugin API code template.
 * Skills decouple the MCP tool interface from the Plugin API implementation:
 *   - guardian_run_skill("get_node_variables", { nodeId: "123:456" })
 *   - The skill's codeTemplate is interpolated with params, then sent to
 *     guardian_figma_execute (which forwards to the Guardian Figma plugin bridge)
 *
 * Skills can be:
 *   - "builtin"  : shipped with Guardian, focused on DS compliance use cases
 *   - "user"     : created by the user, stored as JSON in mcp/skills/user/
 *
 * Southleft Figma Console compatibility is optional:
 *   a user can create skills like "create_variable", "set_node_fill", etc.
 *   by writing the corresponding Plugin API code template.
 */

export type SkillCategory =
  | "ds-inspection"  // Read DS state: variables, components, tokens
  | "ds-annotation"  // Write annotations, flags, markers on canvas
  | "variables"      // CRUD on Figma variables/tokens
  | "nodes"          // Node manipulation (fills, strokes, opacity, etc.)
  | "components"     // Component/instance operations
  | "user"           // User-defined skills

export type SkillParamType = "string" | "number" | "boolean" | "object" | "array"

export type SkillParam = {
  name: string
  type: SkillParamType
  required: boolean
  description: string
  default?: unknown
}

export type Skill = {
  name: string
  description: string
  category: SkillCategory
  params: SkillParam[]
  /**
   * Figma Plugin API JavaScript template.
   * Use {{paramName}} for interpolation.
   * The code runs inside an async IIFE in the Figma plugin sandbox.
   * Must return a serializable value (or nothing).
   *
   * Example:
   *   "const node = await figma.getNodeByIdAsync('{{nodeId}}');
   *    return node ? { id: node.id, name: node.name } : null;"
   */
  codeTemplate: string
  source: "builtin" | "user"
  version: string
}

export type SkillRunResult = {
  success: boolean
  result: unknown
  skill: string
  error?: string
}
