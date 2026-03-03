/**
 * Guardian Knowledge — Single source of truth
 *
 * All Guardian agent intelligence lives here. Both the webapp
 * and direct MCP clients consume the same knowledge.
 */

export { GUARDIAN_INSTRUCTIONS } from "./instructions.js"
export { GUARDIAN_RESPONSE_TEMPLATES } from "./response-templates.js"

import { GUARDIAN_INSTRUCTIONS } from "./instructions.js"
import { GUARDIAN_RESPONSE_TEMPLATES } from "./response-templates.js"

/**
 * Full Guardian system prompt = instructions + response templates.
 * Used by the webapp as-is, and exposed via MCP prompts for direct clients.
 */
export const GUARDIAN_SYSTEM_PROMPT = GUARDIAN_INSTRUCTIONS + "\n\n" + GUARDIAN_RESPONSE_TEMPLATES
