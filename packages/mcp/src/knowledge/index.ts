/**
 * Guardian Knowledge — Barrel exports
 *
 * This file serves as the single import point for all Guardian knowledge.
 * It is consumed by:
 *   - The webapp chat route (packages/web/src/lib/system-prompt.ts)
 *     → imports GUARDIAN_SYSTEM_PROMPT for the AI system prompt
 *   - The MCP server (src/server.ts)
 *     → imports MCP_INSTRUCTIONS for ServerOptions.instructions
 *   - MCP prompts (src/prompts/index.ts) and resources (src/resources/index.ts)
 *     → import individual pieces for prompt templates and resources
 *
 * Knowledge architecture (zero duplication):
 *
 *   ds-methodology.ts               ← SHARED: modes, routing, exhaustive rule
 *   guardian-tools-knowledge.ts      ← SHARED: tool descriptions, execution rules
 *   response-templates.ts           ← SHARED: comparison table formats, verdicts
 *        ↓ imported by                    ↓ imported by
 *   guardian-agent-instructions.ts   guardian-mcp-client-instructions.ts
 *   (+ personality, QCM, thinking,   (assembles shared modules
 *    other MCP servers, FR triggers)  for external MCP client context)
 *        ↓                               ↓
 *   GUARDIAN_SYSTEM_PROMPT           MCP_INSTRUCTIONS
 *   (webapp /api/chat)              (ServerOptions.instructions)
 */

export { GUARDIAN_INSTRUCTIONS } from "./guardian-agent-instructions.js"
export { GUARDIAN_RESPONSE_TEMPLATES } from "./response-templates.js"
export { MCP_INSTRUCTIONS } from "./guardian-mcp-client-instructions.js"
export { GUARDIAN_TOOLS_KNOWLEDGE, GUARDIAN_FIGMA_EXECUTE_RULES } from "./guardian-tools-knowledge.js"
export { DS_MODES, DS_ROUTING_RULES, DS_EXHAUSTIVE_RULE } from "./ds-methodology.js"

import { GUARDIAN_INSTRUCTIONS } from "./guardian-agent-instructions.js"
import { GUARDIAN_RESPONSE_TEMPLATES } from "./response-templates.js"

/**
 * Full Guardian system prompt = agent instructions + response templates.
 * Used by the webapp /api/chat route as the AI system prompt.
 */
export const GUARDIAN_SYSTEM_PROMPT = GUARDIAN_INSTRUCTIONS + "\n\n" + GUARDIAN_RESPONSE_TEMPLATES
