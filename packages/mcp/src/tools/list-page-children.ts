import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { executeViaSupabase } from "../lib/figma-bridge.js"

export function registerListPageChildrenTool(server: McpServer, userId?: string): void {
  server.tool(
    "guardian_list_page_children",
    `List all top-level children on the current Figma page with name, type, position, and size.

Use this to check what nodes exist on a page — unlike get_selection_context,
this does NOT require any node to be selected.

Useful for orchestrators to verify what collaborator agents have created.

IMPORTANT: The Guardian Figma plugin must be open in Figma Desktop.`,
    {
      maxChildren: z.number().optional().describe(
        "Maximum number of children to return (default: 50)"
      ),
      targetClientId: z.string().optional().describe(
        "Client ID of the target Figma plugin instance"
      ),
    },
    async ({ maxChildren, targetClientId }) => {
      const max = maxChildren ?? 50
      const code = `
const nodes = figma.currentPage.children;
const max = ${max};
const capped = nodes.slice(0, max);
return {
  pageId: figma.currentPage.id,
  pageName: figma.currentPage.name,
  childCount: nodes.length,
  returnedCount: capped.length,
  truncated: nodes.length > max,
  children: capped.map(node => ({
    id: node.id,
    name: node.name,
    type: node.type,
    x: "x" in node ? node.x : undefined,
    y: "y" in node ? node.y : undefined,
    width: "width" in node ? node.width : undefined,
    height: "height" in node ? node.height : undefined,
    visible: node.visible,
    childCount: "children" in node ? node.children.length : 0,
  })),
};`.trim()

      const requestId = `list-children-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const result = await executeViaSupabase(code, requestId, 10_000, userId, targetClientId)

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      }
    }
  )
}
