import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { getConnectedClients } from "../lib/figma-bridge.js"
import { formatToolResponse } from "../lib/format-response.js"

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
        return formatToolResponse(
          `No Figma plugin clients connected. Make sure the Figma plugin is open with the Guardian webapp loaded.`,
          { success: false, error: "No Figma plugin clients connected.", clients: [] },
        )
      }

      const clientList = clients.map((c) => ({
        clientId: c.clientId,
        shortId: c.shortId,
        label: c.label,
        fileKey: c.fileKey,
        fileUrl: c.figmaContext?.fileUrl ?? (c.fileKey ? `https://www.figma.com/design/${c.fileKey}/` : null),
        fileName: c.figmaContext?.fileName ?? null,
        currentPage: c.figmaContext?.currentPage ?? null,
        pages: c.figmaContext?.pages ?? [],
        currentUser: c.figmaContext?.currentUser ?? null,
      }))

      const descriptions = clients.map((c) => {
        const name = c.figmaContext?.fileName ?? "unknown file"
        const page = c.figmaContext?.currentPage?.name
        return `${c.shortId} (${name}${page ? `, page: ${page}` : ``})`
      })

      return formatToolResponse(
        `Found ${clients.length} connected Figma plugin instance(s): ${descriptions.join(", ")}.`,
        { success: true, clientCount: clients.length, clients: clientList },
      )
    }
  )
}
