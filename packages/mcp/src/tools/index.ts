/**
 * Tool registry — registers all Guardian tools on the MCP server.
 *
 * Investigation tools (return playbooks, no plugin needed):
 *   guardian_check_component_usage  — find existing DS component
 *   guardian_analyze_drift          — measure drift from DS master
 *   guardian_assess_snowflake       — evaluate custom component uniqueness
 *   guardian_surface_pattern        — identify emerging cross-team patterns
 *   guardian_document_gap           — build a DS extension request
 *
 * Execution tools (require Guardian Figma plugin bridge — Phase 2):
 *   guardian_figma_execute          — run arbitrary Plugin API code
 *   guardian_list_skills            — discover available skills
 *   guardian_run_skill              — run a named parameterized skill
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerCheckComponentUsageTool } from "./check-component-usage.js"
import { registerAnalyzeDriftTool } from "./analyze-drift.js"
import { registerAssessSnowflakeTool } from "./assess-snowflake.js"
import { registerSurfacePatternTool } from "./surface-pattern.js"
import { registerDocumentGapTool } from "./document-gap.js"
import { registerFigmaExecuteTool } from "./figma-execute.js"
import { registerSkillsTools } from "./skills.js"

export function registerAllTools(server: McpServer): void {
  // Investigation tools
  registerCheckComponentUsageTool(server)
  registerAnalyzeDriftTool(server)
  registerAssessSnowflakeTool(server)
  registerSurfacePatternTool(server)
  registerDocumentGapTool(server)

  // Execution tools (Phase 2 stubs — functional once plugin bridge exists)
  registerFigmaExecuteTool(server)
  registerSkillsTools(server)
}
