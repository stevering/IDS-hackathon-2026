/**
 * Guardian MCP Client Instructions — Context for external MCP clients
 *
 * WHO USES THIS:
 *   Any MCP client connecting to the Guardian MCP server receives this
 *   via ServerOptions.instructions at session initialization.
 *   Examples: Claude Code, Claude Desktop, VS Code, Cursor, Windsurf.
 *
 * WHAT IT DOES:
 *   Gives the MCP client enough knowledge to perform the same DS compliance
 *   work as the Guardian webapp agent — same modes, same response quality,
 *   same exhaustiveness — without imposing an agent personality.
 *   The client (e.g. Claude) stays itself but knows HOW to use Guardian tools.
 *
 * WHAT IT CONTAINS:
 *   Pure assembly of shared modules — no inline content, zero duplication.
 *   - DS modes, routing rules, exhaustive comparison rule (from ds-methodology.ts)
 *   - Guardian tool descriptions, execution rules (from guardian-tools-knowledge.ts)
 *   - Response templates for comparison tables (from response-templates.ts)
 *   - Tool orchestration workflow (the only content unique to this file)
 */

import { GUARDIAN_TOOLS_KNOWLEDGE, GUARDIAN_FIGMA_EXECUTE_RULES } from "./guardian-tools-knowledge.js"
import { GUARDIAN_RESPONSE_TEMPLATES } from "./response-templates.js"
import { DS_MODES, DS_ROUTING_RULES, DS_EXHAUSTIVE_RULE } from "./ds-methodology.js"

export const MCP_INSTRUCTIONS = `
# Guardian MCP — DS Compliance Toolkit

Guardian MCP provides Design System compliance tools for Figma.
These instructions describe how to perform DS investigations with
the same rigor and output quality as the Guardian agent.

${DS_MODES}

${DS_ROUTING_RULES}

${DS_EXHAUSTIVE_RULE}

# AVAILABLE TOOLS

## Guardian MCP (tools prefixed \`guardian_\`)
${GUARDIAN_TOOLS_KNOWLEDGE}

## Tool Orchestration

### DS Compliance Investigation Workflow
1. Start with \`get_selection_context\` to understand what you're looking at.
2. Use \`detect_token_overrides\` to find hardcoded values.
3. If overrides found, use \`guardian_analyze_drift\` for a structured investigation plan.
4. Use \`get_component_master\` to compare instance vs master.
5. Use \`annotate_drift\` to mark drift visually on canvas.

### Before Creating Components
Always call \`guardian_check_component_usage\` first to verify the component doesn't already exist in the DS library.

${GUARDIAN_FIGMA_EXECUTE_RULES}

${GUARDIAN_RESPONSE_TEMPLATES}
`
