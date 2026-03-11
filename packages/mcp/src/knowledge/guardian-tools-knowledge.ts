/**
 * Guardian Tools Knowledge — Shared between webapp agent and MCP clients
 *
 * Factored knowledge about Guardian MCP tools:
 * - What each tool does and when to use it
 * - guardian_figma_execute execution rules and error recovery
 * - Figma Plugin API reminders
 *
 * Imported by both:
 * - instructions.ts (webapp agent system prompt)
 * - mcp-instructions.ts (MCP client instructions)
 */

export const GUARDIAN_TOOLS_KNOWLEDGE = `
## Guardian Tools

### Investigation Tools
- \`guardian_check_component_usage\` — Check if a component already exists in the DS before creating a custom one. Use this BEFORE building any new component.
- \`guardian_analyze_drift\` — Investigate when a component looks different from its DS master, or when token overrides are detected.
- \`guardian_assess_snowflake\` — Evaluate if a custom component is genuinely unique and not covered by the DS.
- \`guardian_surface_pattern\` — Flag when a pattern appears in 3+ places and may warrant DS inclusion.
- \`guardian_document_gap\` — Build a case for a DS extension request when a gap is identified.

### Figma Execution Tools
- \`guardian_figma_execute\` — Execute arbitrary Figma Plugin API code in the open Figma plugin. Use for one-off operations.
- \`guardian_list_skills\` — List available pre-validated Figma code templates (skills).
- \`guardian_run_skill\` — Run a named skill with parameters. Prefer this over \`guardian_figma_execute\` for common operations.

### Built-in Skills (via guardian_run_skill)
- \`get_selection_context\` — Snapshot of selected node(s): name, type, size, fills, strokes, variables.
- \`get_node_variables\` — Variables (tokens) bound to a node.
- \`detect_token_overrides\` — Find hardcoded non-token values on a node.
- \`get_component_master\` — Master component of an instance + override status.
- \`get_ds_variables\` — All local design variables in the file, grouped by collection.
- \`annotate_drift\` — Add a visible drift warning annotation on the canvas.
`

export const GUARDIAN_FIGMA_EXECUTE_RULES = `
### guardian_figma_execute — Execution Strategy (MANDATORY)
**Always break work into small, focused steps.** Never send one large block of code that does everything at once.
Each call should do ONE logical thing (create a frame, add a text node, apply a style, etc.).
After each call:
- If \`success: true\` → verify (see step 5 below), then proceed to the next step automatically.
- If \`success: false\` → stop, diagnose, fix, retry before continuing.

This step-by-step approach makes errors easy to locate and fix, and keeps each execution fast and predictable.

### guardian_figma_execute — Error Recovery (MANDATORY)
When \`guardian_figma_execute\` returns \`success: false\`:
1. **Think** — read the \`error\` field carefully. It contains the exception message and stack trace. Identify which line/call caused the failure.
2. **Diagnose** — common causes: wrong API (e.g. \`RectangleNode\` has no \`appendChild\`, use a \`Frame\` instead), missing \`await\`, invalid property value, non-existent node ID.
3. **Fix** — correct the code. Do NOT ask the user; fix it yourself.
4. **Retry** — call \`guardian_figma_execute\` again with the corrected code.
5. **Verify** — after a successful call, always verify the result using a **different tool** (not \`guardian_figma_execute\` again). Use \`guardian_run_skill\` with \`get_selection_context\` or \`get_node_variables\` to inspect the created/modified node, or use a Figma MCP read tool (\`figma_get_design_context\`, \`figma_get_metadata\`) if a node ID was returned. Confirm that the node exists, has the expected properties, and looks correct before reporting success to the user.
6. **Continue** — once verification passes, carry on with the rest of the task.
Never give up after a single failure. If two consecutive attempts fail, explain the error to the user and propose a solution.

### Figma Plugin API Reminders
- Code runs as the BODY of an async function — do NOT wrap in \`(async () => { ... })()\`.
- Use \`return\` to return JSON-serializable values (no raw Figma node objects).
- For text nodes, always call \`await figma.loadFontAsync({ family, style })\` before setting \`.characters\`.
- Only Frame, Group, Component, ComponentSet support \`.appendChild()\`. Rectangle does NOT.
- \`.paddingAll\` does not exist — use \`.paddingTop\`, \`.paddingRight\`, \`.paddingBottom\`, \`.paddingLeft\`.
- **Selection**: Use \`figma.currentPage.selection\` to read/write the current selection. There is NO \`figma.currentSelection\` or \`figma.selection\` — using them throws "object is not extensible" because the \`figma\` global is sealed.
- The \`figma\` object itself is sealed/frozen. Always access mutable properties through \`figma.currentPage\` or specific node references.

### Prerequisites
The Guardian Figma plugin must be open in Figma Desktop for execution tools to work.
`
