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

### Page Inspection Tools
- \`guardian_list_page_children\` — List all top-level nodes on the current page (name, type, position, size). Use this instead of get_selection_context to check what exists on a page without requiring a selection.

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
- **Node lookup**: ALWAYS use \`await figma.getNodeByIdAsync(id)\` — NEVER use \`figma.getNodeById(id)\`. The sync version throws "Cannot call with documentAccess: dynamic-page" in modern Figma plugins.
- For text nodes, always call \`await figma.loadFontAsync({ family, style })\` before setting \`.characters\`.
- Only Frame, Group, Component, ComponentSet support \`.appendChild()\`. Rectangle does NOT.
- \`.paddingAll\` does not exist — use \`.paddingTop\`, \`.paddingRight\`, \`.paddingBottom\`, \`.paddingLeft\`.
- **Selection**: Use \`figma.currentPage.selection\` to read/write the current selection. There is NO \`figma.currentSelection\` or \`figma.selection\` — using them throws "object is not extensible" because the \`figma\` global is sealed.
- The \`figma\` object itself is sealed/frozen. Always access mutable properties through \`figma.currentPage\` or specific node references.
- **Triangles & Polygons**: Use \`figma.createPolygon()\` with \`.pointCount = 3\` for triangles, \`.pointCount = 5\` for pentagons, etc. Set size with \`.resize(w, h)\`. Do NOT use \`figma.createStar()\` for simple polygons — StarNode has \`.innerRadius\` (0-1 ratio) which creates star shapes, not regular polygons.
- **Colors**: Figma uses RGB in 0–1 range, NOT 0–255 and NOT hex strings. Convert hex: \`#2563EB\` → \`{ r: 0x25/255, g: 0x63/255, b: 0xEB/255 }\` i.e. \`{ r: 0.145, g: 0.388, b: 0.922 }\`. Always use \`{ type: 'SOLID', color: { r, g, b } }\` in \`.fills\`.
- **Auto-layout**: Set \`.layoutMode = "VERTICAL"\` or \`"HORIZONTAL"\` on a Frame. Key properties: \`.itemSpacing\` (gap between children), \`.paddingTop/Right/Bottom/Left\`, \`.primaryAxisAlignItems\` (\`"MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN"\`), \`.counterAxisAlignItems\` (\`"MIN" | "CENTER" | "MAX"\`), \`.primaryAxisSizingMode\` / \`.counterAxisSizingMode\` (\`"FIXED" | "AUTO"\` — AUTO = hug contents). Children of auto-layout frames are positioned automatically — do NOT set \`.x\` / \`.y\` on them.
- **Text properties**: \`.fontSize = number\`, \`.fontName = { family: "Inter", style: "Bold" }\` (set AFTER loadFontAsync). Common styles: \`"Regular"\`, \`"Medium"\`, \`"Semi Bold"\`, \`"Bold"\`, \`"Light"\`. \`.textAutoResize = "WIDTH_AND_HEIGHT"\` to auto-size.
- **Frame creation pattern**: \`const frame = figma.createFrame(); frame.name = "..."; frame.resize(w, h); frame.fills = []; frame.layoutMode = "VERTICAL"; frame.itemSpacing = 16;\` then \`frame.appendChild(child)\`.

### Prerequisites
The Guardian Figma plugin must be open in Figma Desktop for execution tools to work.
`
