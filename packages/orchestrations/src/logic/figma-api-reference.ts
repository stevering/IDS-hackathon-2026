/**
 * Condensed Figma Plugin API reference for the agent system prompt.
 *
 * Injected when an agent calls lookup_figma_docs with mode "quick".
 * Covers the most common operations and gotchas that LLMs typically get wrong.
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
`;
