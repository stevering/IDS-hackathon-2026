/**
 * Guardian MCP Prompts
 *
 * Exposes the Guardian agent intelligence as MCP prompts.
 * In Claude Desktop / VS Code, these appear as selectable templates
 * (e.g. /guardian-agent) so direct MCP clients get the full
 * Guardian experience without needing the webapp.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { GUARDIAN_SYSTEM_PROMPT, GUARDIAN_INSTRUCTIONS, GUARDIAN_RESPONSE_TEMPLATES } from "../knowledge/index.js"

export function registerAllPrompts(server: McpServer): void {

  // -------------------------------------------------------------------------
  // guardian-agent — full agent bootstrap
  // -------------------------------------------------------------------------
  server.prompt(
    "guardian-agent",
    "Start a DS Guardian agent session with full investigation capabilities. " +
    "Activates all modes: Figma-to-Code, Figma-to-Figma, Chat, and Code Agent.",
    {
      language: z.enum(["en", "fr"]).optional().describe(
        "Preferred language for responses (default: auto-detect from user)"
      ),
    },
    async ({ language }) => {
      const langNote = language
        ? `\nIMPORTANT: Respond in ${language === "fr" ? "French" : "English"}.`
        : ""

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: GUARDIAN_SYSTEM_PROMPT + langNote +
                "\n\nYou are now initialized as DS Guardian. " +
                "Greet the user briefly and ask how you can help with their design system.",
            },
          },
        ],
      }
    }
  )

  // -------------------------------------------------------------------------
  // guardian-compare-figma-code — Figma-to-Code comparison
  // -------------------------------------------------------------------------
  server.prompt(
    "guardian-compare-figma-code",
    "Compare a Figma component against its code implementation. " +
    "Detects drift between design and development.",
    {
      componentName: z.string().describe(
        "Name of the component to compare (e.g. 'Button', 'Card')"
      ),
    },
    async ({ componentName }) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: GUARDIAN_SYSTEM_PROMPT +
                `\n\nThe user wants to compare the **${componentName}** component between Figma and code. ` +
                "Activate Figma-to-Code comparison mode. " +
                "Use MCP tools to fetch both the Figma design and the code implementation, " +
                "then produce the comparison using the Figma-to-Code response template.",
            },
          },
        ],
      }
    }
  )

  // -------------------------------------------------------------------------
  // guardian-compare-figma-figma — Figma-to-Figma comparison
  // -------------------------------------------------------------------------
  server.prompt(
    "guardian-compare-figma-figma",
    "Compare a derived Figma component against the DS library original. " +
    "Detects drift between a product instance and the source of truth.",
    {
      componentName: z.string().describe(
        "Name of the component to compare (e.g. 'Button', 'Card')"
      ),
    },
    async ({ componentName }) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: GUARDIAN_SYSTEM_PROMPT +
                `\n\nThe user wants to compare the **${componentName}** component between its Figma DS library master and a derived instance. ` +
                "Activate Figma-to-Figma comparison mode. " +
                "Use MCP tools to fetch both the original DS component and the derived version, " +
                "then produce the comparison using the Figma-to-Figma response template.",
            },
          },
        ],
      }
    }
  )
}
