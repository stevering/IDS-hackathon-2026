import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { getSkill, listSkills, interpolate, validateParams } from "../skills/registry.js"

export function registerSkillsTools(server: McpServer): void {

  // -------------------------------------------------------------------------
  // guardian_list_skills
  // -------------------------------------------------------------------------
  server.tool(
    "guardian_list_skills",
    `List all available Guardian skills.

Skills are parameterized Figma Plugin API code templates that run via the
Guardian plugin bridge. They cover common DS compliance operations: inspecting
nodes, detecting token overrides, finding component masters, annotating drift, etc.

Call this before guardian_run_skill to discover skill names and their required params.
Filter by category to narrow results:
  - ds-inspection : read DS state (variables, components, fills)
  - ds-annotation : write annotations/markers on the canvas
  - variables     : create/update Figma variables (user-defined)
  - nodes         : manipulate node properties (user-defined)
  - components    : component/instance operations (user-defined)
  - user          : user-created custom skills`,
    {
      category: z.string().optional().describe(
        "Filter by skill category: 'ds-inspection', 'ds-annotation', " +
        "'variables', 'nodes', 'components', 'user'"
      ),
    },
    async ({ category }) => {
      const skills = await listSkills(category)
      const summary = skills.map((s) => ({
        name: s.name,
        description: s.description,
        category: s.category,
        source: s.source,
        params: s.params.map((p) => ({
          name: p.name,
          type: p.type,
          required: p.required,
          description: p.description,
          ...(p.default !== undefined ? { default: p.default } : {}),
        })),
      }))

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: summary.length,
                category: category ?? "all",
                skills: summary,
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  // -------------------------------------------------------------------------
  // guardian_run_skill
  // -------------------------------------------------------------------------
  server.tool(
    "guardian_run_skill",
    `Run a named Guardian skill in Figma via the Guardian plugin bridge.

Skills are pre-validated Figma Plugin API code templates. Prefer this over
guardian_figma_execute for common DS operations — skills have tested, safe code.

Workflow:
  1. Call guardian_list_skills to see available skills and their params
  2. Call guardian_run_skill with the skill name and required params
  3. The skill's code template is interpolated with your params
  4. The result is returned from the Figma plugin

IMPORTANT: The Guardian Figma plugin must be open in Figma Desktop.

Built-in skills for DS compliance:
  - get_selection_context   : snapshot of selected node(s)
  - get_node_variables      : variables bound to a node (requires nodeId)
  - detect_token_overrides  : find hardcoded non-token values (requires nodeId)
  - get_component_master    : master component of an instance (requires nodeId)
  - get_ds_variables        : list all local tokens in the file
  - annotate_drift          : add drift warning on canvas (requires nodeId)`,
    {
      name: z.string().min(1).describe(
        "Skill name (from guardian_list_skills, e.g. 'get_selection_context')"
      ),
      params: z.record(z.unknown()).optional().describe(
        "Parameters for the skill (see guardian_list_skills for required params per skill)"
      ),
    },
    async ({ name, params }) => {
      const skill = await getSkill(name)
      if (!skill) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: `Skill '${name}' not found. Call guardian_list_skills to see available skills.`,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      const resolvedParams = params ?? {}
      const missing = validateParams(skill, resolvedParams)
      if (missing.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: `Missing required params for skill '${name}': ${missing.join(", ")}`,
                  skill: {
                    name: skill.name,
                    params: skill.params,
                  },
                },
                null,
                2
              ),
            },
          ],
        }
      }

      const interpolatedCode = interpolate(skill, resolvedParams)

      // NOTE: Phase 2 stub — same as guardian_figma_execute.
      // When the bridge is implemented, this sends interpolatedCode to the plugin.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: false,
                error:
                  "guardian_run_skill requires the Guardian Figma plugin bridge (Phase 2). " +
                  "The plugin bridge is not yet implemented.",
                skill: name,
                params_resolved: resolvedParams,
                interpolated_code: interpolatedCode,
                note:
                  "The interpolated_code above is ready to execute. " +
                  "You can paste it into guardian_figma_execute once the bridge is available, " +
                  "or run it manually via the Southleft Figma Console MCP.",
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
