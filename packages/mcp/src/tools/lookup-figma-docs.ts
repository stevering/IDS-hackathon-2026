import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { FIGMA_API_QUICK_REFERENCE, fetchFigmaDocsFromWeb } from "../lib/figma-docs.js"

export function registerLookupFigmaDocsTool(server: McpServer): void {
  server.tool(
    "lookup_figma_docs",
    "Look up Figma Plugin API documentation. " +
    "Use mode 'quick' for a condensed reference covering common APIs, creation methods, auto-layout, text, fills, effects, and gotchas. " +
    "Use mode 'full' to fetch the complete official documentation for a specific node type (FrameNode, TextNode, etc.).",
    {
      topic: z.string().optional().describe(
        "Node type to look up (only used in 'full' mode). E.g. 'FrameNode', 'TextNode', 'EllipseNode', 'figma' (global object). Ignored in 'quick' mode."
      ),
      mode: z.enum(["quick", "full"]).optional().describe(
        "quick = static condensed ref (~4KB, instant, topic ignored). full = fetch from developers.figma.com for a specific node type. Default: quick."
      ),
    },
    async ({ topic, mode }) => {
      const effectiveMode = mode ?? "quick"

      if (effectiveMode === "quick") {
        return {
          content: [{ type: "text" as const, text: FIGMA_API_QUICK_REFERENCE }],
        }
      }

      // Full mode — fetch from developers.figma.com
      if (!topic) {
        return {
          content: [{ type: "text" as const, text: `Mode "full" requires a topic (e.g. "TextNode", "FrameNode"). Use mode "quick" for the general reference.` }],
        }
      }
      const result = await fetchFigmaDocsFromWeb(topic)
      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `Could not fetch docs for "${topic}": ${result.error}. Try mode "quick" instead.` }],
        }
      }
      return {
        content: [{ type: "text" as const, text: result.content! }],
      }
    }
  )
}
