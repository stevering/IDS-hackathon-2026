/**
 * Guardian MCP Server factory
 *
 * Creates and configures the McpServer instance with all registered tools.
 * Transport-agnostic: the caller (index.ts) decides stdio vs HTTP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerAllTools } from "./tools/index.js"
import { registerAllPrompts } from "./prompts/index.js"
import { registerAllResources } from "./resources/index.js"
import { MCP_INSTRUCTIONS } from "./knowledge/guardian-mcp-client-instructions.js"

export function createGuardianServer(): McpServer {
  const server = new McpServer(
    {
      name: "guardian",
      version: "0.1.0",
    },
    {
      instructions: MCP_INSTRUCTIONS,
    }
  )

  registerAllTools(server)
  registerAllPrompts(server)
  registerAllResources(server)

  return server
}
