/**
 * Figma Plugin API reference constants for agent prompts.
 *
 * Two exports:
 * - FIGMA_API_QUICK_REFERENCE — full reference, used by lookup_figma_docs (mode "quick")
 *   and by the fallback system prompt when no figmaconsole_ MCP tools are available.
 * - FIGMA_API_EXECUTE_SUPPLEMENT — condensed gotchas + worked example, injected lazily
 *   the first time an agent calls raw figma_execute when figmaconsole_ tools are available.
 *
 * Source: https://developers.figma.com/docs/plugins/api/
 */

export const FIGMA_API_QUICK_REFERENCE = `## Figma Plugin API — Quick Reference

### Node creation (figma global)
| Method | Returns | Description |
|--------|---------|-------------|
| figma.createFrame() | FrameNode | Container with optional auto-layout |
| figma.createRectangle() | RectangleNode | Rectangle shape |
| figma.createEllipse() | EllipseNode | Ellipse/circle shape |
| figma.createText() | TextNode | Text node (must load font first) |
| figma.createPolygon() | PolygonNode | Polygon (default: triangle). Set .pointCount for sides |
| figma.createStar() | StarNode | Star shape. Has .innerRadius (0-1) |
| figma.createLine() | LineNode | Single line |
| figma.createVector() | VectorNode | Empty vector network |
| figma.createComponent() | ComponentNode | Reusable component |
| figma.createSection() | SectionNode | Section container |
| figma.createNodeFromSvg(svg) | FrameNode | Create from SVG string |
| figma.createImage(Uint8Array) | Image | Create image from bytes |
| figma.createImageAsync(url) | Promise<Image> | Create image from URL |

### Key figma methods
| Method | Description |
|--------|-------------|
| figma.currentPage | Current PageNode (read/write) |
| figma.viewport.center | { x, y } center of viewport |
| figma.viewport.zoom | Current zoom level |
| figma.getNodeByIdAsync(id) | Find node by ID (ALWAYS use this, NOT getNodeById) |
| figma.loadFontAsync({ family, style }) | MUST call before setting .characters or .fontName |
| figma.group(nodes, parent) | Group nodes together |
| figma.flatten(nodes, parent) | Flatten nodes to VectorNode |
| figma.union(nodes, parent) | Boolean union |
| figma.subtract(nodes, parent) | Boolean subtract |
| figma.notify(message) | Show notification toast |
| figma.listAvailableFontsAsync() | List all available fonts |

### FrameNode (most important node for layouts)
\`\`\`js
const frame = figma.createFrame();
frame.name = "Container";
frame.resize(400, 300);             // width, height (required — default is 100x100)
frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; // white bg
frame.fills = [];                    // transparent (no fill)

// Auto-layout
frame.layoutMode = "VERTICAL";      // "NONE" | "HORIZONTAL" | "VERTICAL"
frame.itemSpacing = 16;             // gap between children
frame.paddingTop = 20;
frame.paddingRight = 20;
frame.paddingBottom = 20;
frame.paddingLeft = 20;
// NOTE: there is NO .paddingAll — set each side individually

// Alignment
frame.primaryAxisAlignItems = "CENTER";    // "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN"
frame.counterAxisAlignItems = "CENTER";    // "MIN" | "CENTER" | "MAX" | "BASELINE"

// Sizing
frame.primaryAxisSizingMode = "AUTO";      // "FIXED" | "AUTO" (AUTO = hug contents)
frame.counterAxisSizingMode = "AUTO";      // "FIXED" | "AUTO"

// Wrap
frame.layoutWrap = "WRAP";                 // "NO_WRAP" | "WRAP"

// Corner radius
frame.cornerRadius = 8;                   // uniform
// OR per-corner:
frame.topLeftRadius = 8;
frame.topRightRadius = 8;
frame.bottomLeftRadius = 0;
frame.bottomRightRadius = 0;

frame.clipsContent = true;                 // clip children to frame bounds

// Children
frame.appendChild(childNode);
frame.insertChild(0, childNode);           // insert at index
frame.children;                            // readonly array
frame.findOne(n => n.name === "Title");    // find by predicate
frame.findAll(n => n.type === "TEXT");     // find all matching
\`\`\`

### RectangleNode
\`\`\`js
const rect = figma.createRectangle();
rect.resize(200, 100);
rect.fills = [{ type: 'SOLID', color: { r: 0.15, g: 0.39, b: 0.92 } }];
rect.cornerRadius = 8;
rect.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
rect.strokeWeight = 2;
rect.strokeAlign = "INSIDE";              // "CENTER" | "INSIDE" | "OUTSIDE"
rect.opacity = 0.8;
\`\`\`

### EllipseNode
\`\`\`js
const ellipse = figma.createEllipse();
ellipse.resize(100, 100);                 // circle
ellipse.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
// Arc: ellipse.arcData = { startingAngle: 0, endingAngle: Math.PI, innerRadius: 0.5 };
\`\`\`

### TextNode (MUST load font before setting text)
\`\`\`js
const text = figma.createText();
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
text.characters = "Hello World";
text.fontSize = 24;
text.fontName = { family: "Inter", style: "Bold" };  // set AFTER loadFontAsync
// Common styles: "Regular", "Medium", "Semi Bold", "Bold", "Light", "Italic"
text.textAlignHorizontal = "CENTER";       // "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED"
text.textAlignVertical = "CENTER";         // "TOP" | "CENTER" | "BOTTOM"
text.textAutoResize = "WIDTH_AND_HEIGHT";  // "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE"
text.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; // text color via fills
text.letterSpacing = { value: 0.5, unit: "PIXELS" };  // or unit: "PERCENT"
text.lineHeight = { value: 32, unit: "PIXELS" };       // or { unit: "AUTO" }
\`\`\`

### Fills & Strokes (Paint type)
\`\`\`js
// Solid color — NEVER include 'a' (alpha) in color object
{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }
// With opacity (NOT alpha in color):
{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 }, opacity: 0.3 }

// Gradient
{
  type: 'GRADIENT_LINEAR',
  gradientTransform: [[1, 0, 0], [0, 1, 0]],
  gradientStops: [
    { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },   // gradient stops DO use 'a'
    { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
  ]
}
// NOTE: Only gradient stops use { r, g, b, a }. Solid fills/strokes use { r, g, b } only.

// Hex to Figma RGB: #2563EB → { r: 0x25/255, g: 0x63/255, b: 0xEB/255 }
// i.e. { r: 0.145, g: 0.388, b: 0.922 }
\`\`\`

### Effects
\`\`\`js
// Drop shadow — MUST include blendMode and visible
node.effects = [{
  type: 'DROP_SHADOW',
  color: { r: 0, g: 0, b: 0, a: 0.25 },  // effects use RGBA (with 'a')
  offset: { x: 0, y: 4 },
  radius: 8,
  spread: 0,
  visible: true,
  blendMode: 'NORMAL'
}];

// Blur
node.effects = [{ type: 'LAYER_BLUR', radius: 10, visible: true }];
\`\`\`

### Child layout properties (children of auto-layout frames)
\`\`\`js
child.layoutAlign = "STRETCH";           // "MIN" | "CENTER" | "MAX" | "STRETCH" | "INHERIT"
child.layoutGrow = 1;                    // 0 = fixed, 1 = fill
child.layoutSizingHorizontal = "FILL";   // "FIXED" | "HUG" | "FILL"
child.layoutSizingVertical = "HUG";      // "FIXED" | "HUG" | "FILL"
child.layoutPositioning = "ABSOLUTE";    // "AUTO" | "ABSOLUTE" (absolute within auto-layout)
// NOTE: Do NOT set .x / .y on children of auto-layout frames (positioned automatically)
\`\`\`

### Common properties (all nodes)
| Property | Type | Notes |
|----------|------|-------|
| .id | string | Unique, readonly |
| .name | string | Layer name |
| .visible | boolean | Show/hide |
| .opacity | number | 0-1 |
| .rotation | number | Degrees, -180 to 180 |
| .x, .y | number | Position (do NOT set in auto-layout children) |
| .width, .height | number | Readonly — use .resize(w, h) |
| .parent | BaseNode | Readonly |
| .remove() | void | Delete node |
| .clone() | node | Duplicate |
| .exportAsync(settings?) | Promise<Uint8Array> | Export as image |

### Variables API (design tokens)
\`\`\`js
// Read local variables
const collections = figma.variables.getLocalVariableCollections();
const vars = figma.variables.getLocalVariables();

// Create variable collection
const collection = figma.variables.createVariableCollection("Colors");
const mode = collection.modes[0];

// Create and set variable
const colorVar = figma.variables.createVariable("primary", collection, "COLOR");
colorVar.setValueForMode(mode.modeId, { r: 0.15, g: 0.39, b: 0.92 });

// Bind variable to node property
node.setBoundVariable("fills", 0, colorVar);    // bind fill[0] to variable
node.setBoundVariable("itemSpacing", colorVar);  // bind spacing

// Read variable values
const val = variable.valuesByMode[modeId];       // returns color/float/string value
\`\`\`

### ComponentNode
\`\`\`js
// Create component
const comp = figma.createComponent();
comp.name = "Button";
comp.resize(140, 44);
// Add children to component, then create instances:
const instance = comp.createInstance();

// Variants: create multiple components, then combine
const variants = [primaryBtn, secondaryBtn];
const componentSet = figma.combineAsVariants(variants, parent);
\`\`\`

### CRITICAL GOTCHAS
1. Colors: Solid fills/strokes use { r, g, b } in 0-1 range. NO 'a' key. Use paint-level opacity instead.
2. Effects colors: Effects (shadows) DO use { r, g, b, a }. Always include blendMode and visible.
3. Font loading: MUST call await figma.loadFontAsync() BEFORE setting .characters or .fontName
4. No .paddingAll: Set paddingTop, paddingRight, paddingBottom, paddingLeft individually
5. width/height readonly: Use .resize(w, h), NOT .width = x
6. children readonly: Use .appendChild() or .insertChild(), NOT .children = [...]
7. Pages are infinite: figma.currentPage has NO .width or .height. Use figma.viewport.center
8. getNodeByIdAsync: ALWAYS use async version, NEVER figma.getNodeById()
9. Fresh scope: Each execution runs in a fresh scope — all variables must be declared
10. Auto-layout children: Do NOT set .x / .y on children — they are positioned automatically
11. figma.closePlugin(): NEVER call this — it kills the plugin bridge
12. No TypeScript: Code runs as plain JavaScript — no "as Type" casts
13. FrameNode has no .backgroundColor: Use .fills instead
14. GroupNode has no .layoutMode: Use figma.createFrame() for auto-layout
15. Only Frame, Group, Component, ComponentSet support .appendChild(). Rectangle does NOT.
16. figma object is sealed: Access mutable properties through figma.currentPage or node references
17. Triangles: Use figma.createPolygon() with .pointCount = 3, NOT figma.createStar()

### Complete section example (target: 30-80 lines per call)
\`\`\`js
// Create a Stats section with 4 KPI cards — ALL in one call
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
await figma.loadFontAsync({ family: "Inter", style: "Bold" });

const parent = await figma.getNodeByIdAsync("CONTAINER_ID");

// Section wrapper
const section = figma.createFrame();
section.name = "Stats Overview";
section.layoutMode = "VERTICAL";
section.itemSpacing = 16;
section.paddingTop = 24; section.paddingRight = 24;
section.paddingBottom = 24; section.paddingLeft = 24;
section.primaryAxisSizingMode = "AUTO";
section.counterAxisSizingMode = "AUTO";
section.layoutSizingHorizontal = "FILL";
section.fills = [];

// Section title
const title = figma.createText();
title.characters = "Performance Overview";
title.fontSize = 20;
title.fontName = { family: "Inter", style: "Bold" };
title.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
section.appendChild(title);

// Cards row
const row = figma.createFrame();
row.name = "Cards";
row.layoutMode = "HORIZONTAL";
row.itemSpacing = 16;
row.primaryAxisSizingMode = "AUTO";
row.counterAxisSizingMode = "AUTO";
row.fills = [];

const stats = [
  { label: "Users", value: "12,458", delta: "+12%" },
  { label: "Revenue", value: "$84.2K", delta: "+8%" },
  { label: "Orders", value: "1,234", delta: "+23%" },
  { label: "Conversion", value: "3.2%", delta: "-2%" },
];

for (const s of stats) {
  const card = figma.createFrame();
  card.name = s.label;
  card.layoutMode = "VERTICAL";
  card.itemSpacing = 8;
  card.paddingTop = 16; card.paddingRight = 20;
  card.paddingBottom = 16; card.paddingLeft = 20;
  card.primaryAxisSizingMode = "AUTO";
  card.counterAxisSizingMode = "AUTO";
  card.cornerRadius = 12;
  card.fills = [{ type: 'SOLID', color: { r: 0.12, g: 0.16, b: 0.24 } }];

  const lbl = figma.createText();
  lbl.characters = s.label;
  lbl.fontSize = 12;
  lbl.fills = [{ type: 'SOLID', color: { r: 0.6, g: 0.6, b: 0.7 } }];
  card.appendChild(lbl);

  const val = figma.createText();
  val.characters = s.value;
  val.fontSize = 28;
  val.fontName = { family: "Inter", style: "Bold" };
  val.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  card.appendChild(val);

  const delta = figma.createText();
  delta.characters = s.delta;
  delta.fontSize = 14;
  delta.fills = [{ type: 'SOLID', color: s.delta.startsWith('+')
    ? { r: 0.2, g: 0.8, b: 0.4 }
    : { r: 0.9, g: 0.3, b: 0.3 } }];
  card.appendChild(delta);

  row.appendChild(card);
}

section.appendChild(row);
parent.appendChild(section);
return section.id;
\`\`\`
`;

// ---------------------------------------------------------------------------
// Lazy supplement — injected on first figma_execute call when figmaconsole_ is primary
// ---------------------------------------------------------------------------

export const FIGMA_API_EXECUTE_SUPPLEMENT = `## Figma Plugin API — Reference for raw code execution

You are now using figma_execute (raw Figma Plugin API code). Review these rules carefully.

### Critical Gotchas
1. **Colors 0-1 range**: \`{ r: 0.15, g: 0.39, b: 0.92 }\` — NOT 0-255, NOT hex. Hex conversion: \`#2563EB\` → \`{ r: 0x25/255, g: 0x63/255, b: 0xEB/255 }\`.
2. **No alpha in solid fills/strokes**: Use \`{ type: 'SOLID', color: { r, g, b }, opacity: 0.3 }\` — NO \`a\` key. Only gradient stops and effects use \`{ r, g, b, a }\`.
3. **Effects require blendMode + visible**: \`{ type: 'DROP_SHADOW', color: { r:0, g:0, b:0, a:0.25 }, offset: { x:0, y:4 }, radius: 8, spread: 0, visible: true, blendMode: 'NORMAL' }\`
4. **Font loading**: MUST \`await figma.loadFontAsync({ family: "Inter", style: "Regular" })\` BEFORE setting \`.characters\` or \`.fontName\`.
5. **No .paddingAll**: Set \`.paddingTop\`, \`.paddingRight\`, \`.paddingBottom\`, \`.paddingLeft\` individually.
6. **width/height readonly**: Use \`.resize(w, h)\`, NOT \`.width = x\`.
7. **children readonly**: Use \`.appendChild()\`, NOT \`.children = [...]\`. Only Frame/Group/Component support it — Rectangle does NOT.
8. **Pages are infinite**: \`figma.currentPage\` has NO \`.width\`/\`.height\`. Use \`figma.viewport.center\`.
9. **getNodeByIdAsync**: ALWAYS use async version. NEVER \`figma.getNodeById()\`.
10. **Fresh scope**: Each call runs in a fresh JavaScript scope — variables do NOT persist between calls.
11. **Auto-layout children**: Do NOT set \`.x\`/\`.y\` — positioned automatically. Use \`.layoutSizingHorizontal = "FILL"\` to stretch.
12. **No TypeScript**: Code runs as plain JS — no \`as Type\` casts.
13. **figma.closePlugin()**: NEVER call this — it kills the plugin bridge.
14. **Auto-layout setup**: \`.layoutMode = "VERTICAL"\`, \`.itemSpacing\`, \`.primaryAxisSizingMode = "AUTO"\` (hug).

### ID Handoff Pattern
- Step 1: end with \`return node.id;\` to capture the container ID
- Step 2+: start with \`const parent = await figma.getNodeByIdAsync("PREVIOUS_ID");\`
- The system shows "Created node IDs: [...]" after each step — use these exact IDs

### Recovery
- Read the error carefully — most failures are: wrong property name, missing font load, alpha in solid fill
- Fix the SPECIFIC issue and retry (do not skip ahead)
- If the same error repeats twice, SIMPLIFY: remove optional features and create minimal structure
- After 3 failures on one step, create a PLACEHOLDER (empty named frame) and move on

### Worked Example: "Create a color palette"

**Plan:**
1. Create root frame (horizontal auto-layout) → returns frame ID
2. Add 5 color swatches → needs frame ID from step 1

**Step 1:**
\`\`\`js
const frame = figma.createFrame();
frame.name = "Color Palette";
frame.layoutMode = "HORIZONTAL";
frame.itemSpacing = 16;
frame.paddingTop = 24; frame.paddingRight = 24; frame.paddingBottom = 24; frame.paddingLeft = 24;
frame.primaryAxisSizingMode = "AUTO";
frame.counterAxisSizingMode = "AUTO";
frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
frame.cornerRadius = 12;
figma.currentPage.appendChild(frame);
return frame.id;
\`\`\`

**Step 2:**
\`\`\`js
const parent = await figma.getNodeByIdAsync("123:456");
const colors = [
  { name: "Primary", r: 0.15, g: 0.39, b: 0.92 },
  { name: "Secondary", r: 0.44, g: 0.19, b: 0.76 },
];
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
for (const c of colors) {
  const swatch = figma.createFrame();
  swatch.name = c.name;
  swatch.layoutMode = "VERTICAL";
  swatch.itemSpacing = 8;
  swatch.primaryAxisSizingMode = "AUTO";
  swatch.counterAxisSizingMode = "AUTO";
  const circle = figma.createEllipse();
  circle.resize(48, 48);
  circle.fills = [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b } }];
  swatch.appendChild(circle);
  const label = figma.createText();
  label.characters = c.name;
  label.fontSize = 12;
  label.fills = [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2 } }];
  swatch.appendChild(label);
  parent.appendChild(swatch);
}
\`\`\`

For detailed API docs on specific node types, call \`lookup_figma_docs({ topic: "FrameNode", mode: "full" })\`.
`;

// ---------------------------------------------------------------------------
// High-level tool supplement — injected into system prompt when figmaconsole_
// tools are available (hasExternalFigmaTools=true). Covers gotchas that
// high-level tools don't handle (e.g., TEXT nodes need font loading).
// Source: https://github.com/figma/mcp-server-guide/tree/main/skills/figma-use
// ---------------------------------------------------------------------------

export const FIGMA_HIGHLEVEL_TOOLS_SUPPLEMENT = `## Figma — Gotchas for figmaconsole_ tools

Even when using high-level tools (figmaconsole_figma_create_child, figmaconsole_figma_set_fills, etc.),
some Figma operations require raw code execution. Know when to switch to \`figmaconsole_figma_execute\`.

### TEXT nodes: ALWAYS use figma_execute (not create_child)

\`figmaconsole_figma_create_child(type: "TEXT")\` creates the node but does NOT load fonts.
Result: \`width: 0, height: 15\` — invisible text. **Always use figma_execute for text:**

\`\`\`js
const parent = await figma.getNodeByIdAsync("PARENT_ID");
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
const text = figma.createText();
text.characters = "Hello World";
text.fontSize = 16;
text.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
parent.appendChild(text);
return text.id;
\`\`\`

Font style names vary per provider ("SemiBold" vs "Semi Bold"). Use fallback:
\`\`\`js
async function loadFont(family, preferred, fallback = "Regular") {
  try { await figma.loadFontAsync({ family, style: preferred }); return { family, style: preferred }; }
  catch { await figma.loadFontAsync({ family, style: fallback }); return { family, style: fallback }; }
}
\`\`\`

### Overlap prevention for top-level nodes

Every \`figma.create*()\` places the node at (0,0). Top-level nodes overlap each other.
**Children of auto-layout frames don't need this** — they are positioned by the parent.

\`\`\`js
// For top-level nodes only — find rightmost content and place to the right
const page = figma.currentPage;
let maxX = 0;
for (const child of page.children) {
  const right = child.x + child.width;
  if (right > maxX) maxX = right;
}
const frame = figma.createFrame();
frame.resize(400, 300);
page.appendChild(frame);
frame.x = maxX + 100;
\`\`\`

### Colors are 0-1 range, fills are immutable

\`\`\`js
// WRONG: node.fills[0].color = { r: 1, g: 0, b: 0 }  (mutating in place does nothing)
// CORRECT: clone, modify, reassign
const fills = JSON.parse(JSON.stringify(node.fills));
fills[0].color = { r: 1, g: 0, b: 0 };
node.fills = fills;

// Hex to Figma: #2563EB → { r: 0x25/255, g: 0x63/255, b: 0xEB/255 }
\`\`\`

### Page switching: use async only

\`\`\`js
// WRONG: figma.currentPage = page  (throws "not supported")
// CORRECT:
await figma.setCurrentPageAsync(page);
\`\`\`

### Return ALL created node IDs

Every script must return all created/mutated node IDs for subsequent steps:
\`\`\`js
return { createdNodeIds: [frame.id, rect.id, text.id], rootNodeId: frame.id };
\`\`\`

### Auto-layout setup must be on Frame, not Group/Rectangle

Only FrameNode, ComponentNode support \`.layoutMode\`. GroupNode and RectangleNode do NOT.
Set \`.layoutMode\` BEFORE adding children for predictable sizing.

### When to use figma_execute vs high-level tools

| Operation | Use | Why |
|---|---|---|
| Create text with font | \`figma_execute\` | Needs \`loadFontAsync\` |
| Auto-layout with padding | \`figma_execute\` | 4 padding props + sizing |
| Simple rectangle/ellipse | \`create_child\` | Just type + parent |
| Set solid fill color | \`set_fills\` | Simple hex input |
| Complex gradients/effects | \`figma_execute\` | Structured paint objects |
| Resize node | \`resize_node\` | Simple width/height |
| Component + variants | \`figma_execute\` | Complex API (combineAsVariants) |
`;

