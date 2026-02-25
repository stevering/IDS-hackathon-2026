import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

export function registerFigmaExecuteTool(server: McpServer): void {
  server.tool(
    "guardian_figma_execute",
    `Execute arbitrary Figma Plugin API code via the Guardian Figma plugin bridge.

Use this for one-off operations not covered by guardian_run_skill.
Prefer guardian_run_skill for common DS operations (it uses pre-validated code templates).

IMPORTANT: The Guardian Figma plugin must be open in Figma Desktop for this to work.
If the plugin is not open, the call will time out.

The code runs inside an async IIFE in the Figma plugin sandbox with full Plugin API access.
Return values must be JSON-serializable. Use figma.* APIs directly.

Example — get current selection:
  code: "return figma.currentPage.selection.map(n => ({ id: n.id, name: n.name }))"

Example — create a variable:
  code: "const col = figma.variables.createVariableCollection('Tokens'); return { id: col.id }"`,
    {
      code: z.string().min(1).describe(
        "Figma Plugin API JavaScript code to execute. " +
        "Runs in an async context — you can use await. " +
        "Return a JSON-serializable value for the result."
      ),
      timeout: z.number().optional().describe(
        "Execution timeout in milliseconds (default: 10000)"
      ),
    },
    async ({ code, timeout }) => {
      // NOTE: This tool is a stub for Phase 2 (Guardian Figma plugin bridge).
      // When the bridge plugin is implemented, this handler will:
      //   1. Send the code to the Guardian webapp via a connected channel
      //   2. The webapp forwards it to the Figma plugin via useFigmaPlugin.executeCode()
      //   3. The plugin executes it and returns the result

      const _timeout = timeout ?? 10000

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: false,
                error:
                  "guardian_figma_execute requires the Guardian Figma plugin bridge (Phase 2). " +
                  "The plugin bridge is not yet implemented. " +
                  "Use the Southleft Figma Console MCP (figmaconsole_execute_plugin_code) " +
                  "as an alternative if you have the bridge plugin running.",
                code_received: code,
                timeout: _timeout,
                next_step:
                  "The Guardian Figma plugin (figma-plugin/) needs to be created with " +
                  "a WebSocket bridge to the webapp. See Phase 2 in the plan.",
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
