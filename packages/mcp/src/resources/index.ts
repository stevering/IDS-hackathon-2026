/**
 * Guardian MCP Resources
 *
 * Exposes Guardian knowledge as MCP resources that AI agents
 * can read on-demand during a conversation. This provides
 * reference material without requiring the full system prompt.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { GUARDIAN_INSTRUCTIONS } from "../knowledge/index.js"
import { GUARDIAN_RESPONSE_TEMPLATES } from "../knowledge/index.js"
import { PLAYBOOKS } from "../guardian/playbooks.js"

export function registerAllResources(server: McpServer): void {

  // -------------------------------------------------------------------------
  // guardian://instructions — core agent instructions
  // -------------------------------------------------------------------------
  server.resource(
    "guardian-instructions",
    "guardian://instructions",
    {
      description:
        "Core DS Guardian agent instructions: identity, modes, operating principles, " +
        "MCP tool routing, and comparison rules. Read this to understand how Guardian works.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "guardian://instructions",
          text: GUARDIAN_INSTRUCTIONS,
          mimeType: "text/plain",
        },
      ],
    })
  )

  // -------------------------------------------------------------------------
  // guardian://response-templates — response format templates
  // -------------------------------------------------------------------------
  server.resource(
    "guardian-response-templates",
    "guardian://response-templates",
    {
      description:
        "Response format templates for each Guardian mode: Figma-to-Code comparison, " +
        "Figma-to-Figma comparison, Chat, and Code Agent. Use these to format your responses.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "guardian://response-templates",
          text: GUARDIAN_RESPONSE_TEMPLATES,
          mimeType: "text/plain",
        },
      ],
    })
  )

  // -------------------------------------------------------------------------
  // guardian://playbooks — investigation playbooks as JSON
  // -------------------------------------------------------------------------
  server.resource(
    "guardian-playbooks",
    "guardian://playbooks",
    {
      description:
        "All Guardian investigation playbooks as JSON. Contains step-by-step " +
        "investigation strategies for: component usage, drift detection, snowflake " +
        "assessment, pattern recognition, and governance requests.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "guardian://playbooks",
          text: JSON.stringify(PLAYBOOKS, null, 2),
          mimeType: "application/json",
        },
      ],
    })
  )
}
