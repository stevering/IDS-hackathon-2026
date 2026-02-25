/**
 * Guardian MCP Server factory
 *
 * Creates and configures the McpServer instance with all registered tools.
 * Transport-agnostic: the caller (index.ts) decides stdio vs HTTP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerAllTools } from "./tools/index.js"

export function createGuardianServer(): McpServer {
  const server = new McpServer({
    name: "guardian",
    version: "0.1.0",
  })

  registerAllTools(server)

  return server
}
