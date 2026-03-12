import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { getConnectedClients } from "../lib/figma-bridge.js"

export function registerGetConnectedClientsTool(server: McpServer, userId?: string): void {
  server.tool(
    "get_connected_clients",
    `List all connected Figma plugin instances and their file context.

Returns for each connected plugin:
- clientId / shortId / label — identifiers for targeting with other tools
- fileKey — the Figma file key
- figmaContext — fileName, fileUrl, pages, currentPage, currentUser

This is a lightweight presence query — no code is executed in the plugin.
Use this to discover which Figma files are currently open before running other tools.`,
    {},
    async () => {
      const clients = await getConnectedClients(userId)

      if (clients.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "No Figma plugin clients connected. Make sure the Figma plugin is open with the Guardian webapp loaded.",
              clients: [],
            }, null, 2),
          }],
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            clientCount: clients.length,
            clients: clients.map((c) => ({
              clientId: c.clientId,
              shortId: c.shortId,
              label: c.label,
              fileKey: c.fileKey,
              fileUrl: c.figmaContext?.fileUrl ?? (c.fileKey ? `https://www.figma.com/design/${c.fileKey}/` : null),
              fileName: c.figmaContext?.fileName ?? null,
              currentPage: c.figmaContext?.currentPage ?? null,
              pages: c.figmaContext?.pages ?? [],
              currentUser: c.figmaContext?.currentUser ?? null,
            })),
          }, null, 2),
        }],
      }
    }
  )
}
