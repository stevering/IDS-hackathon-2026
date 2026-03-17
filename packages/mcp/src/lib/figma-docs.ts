/**
 * Figma Plugin API documentation utilities for the MCP server.
 *
 * Re-exports the quick reference and web fetch function.
 * These are duplicated from @guardian/orchestrations because the MCP package
 * is independently bundled with tsup and cannot resolve workspace dependencies.
 */

// Re-export the quick reference from the knowledge layer which is already bundled
import { GUARDIAN_FIGMA_EXECUTE_RULES } from "../knowledge/guardian-tools-knowledge.js"

// ---------------------------------------------------------------------------
// Quick reference — condensed API reference for mode "quick"
// ---------------------------------------------------------------------------

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
| figma.getNodeByIdAsync(id) | Find node by ID (ALWAYS use this, NOT getNodeById) |
| figma.loadFontAsync({ family, style }) | MUST call before setting .characters or .fontName |
| figma.group(nodes, parent) | Group nodes together |
| figma.flatten(nodes, parent) | Flatten nodes to VectorNode |
| figma.union / subtract / intersect / exclude | Boolean operations |
| figma.notify(message) | Show notification toast |
| figma.listAvailableFontsAsync() | List all available fonts |

### FrameNode (auto-layout)
\`\`\`js
const frame = figma.createFrame();
frame.name = "Container";
frame.resize(400, 300);
frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
frame.layoutMode = "VERTICAL";      // "NONE" | "HORIZONTAL" | "VERTICAL"
frame.itemSpacing = 16;
frame.paddingTop = 20; frame.paddingRight = 20; frame.paddingBottom = 20; frame.paddingLeft = 20;
// NO .paddingAll — set each side individually
frame.primaryAxisAlignItems = "CENTER";  // "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN"
frame.counterAxisAlignItems = "CENTER";  // "MIN" | "CENTER" | "MAX" | "BASELINE"
frame.primaryAxisSizingMode = "AUTO";    // "FIXED" | "AUTO" (hug)
frame.counterAxisSizingMode = "AUTO";
frame.cornerRadius = 8;
frame.clipsContent = true;
frame.appendChild(child); frame.insertChild(0, child);
\`\`\`

### TextNode
\`\`\`js
const text = figma.createText();
await figma.loadFontAsync({ family: "Inter", style: "Regular" }); // REQUIRED
text.characters = "Hello";
text.fontSize = 24;
text.fontName = { family: "Inter", style: "Bold" }; // set AFTER loadFontAsync
text.textAlignHorizontal = "CENTER"; // "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED"
text.textAutoResize = "WIDTH_AND_HEIGHT"; // "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE"
text.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; // text color
\`\`\`

### Fills, Strokes & Effects
\`\`\`js
// Solid — NO 'a' in color. Use paint opacity instead
{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 }, opacity: 0.3 }
// Hex → RGB: #2563EB → { r: 0x25/255, g: 0x63/255, b: 0xEB/255 }

// Drop shadow — MUST include blendMode + visible. Effects use RGBA (with 'a')
node.effects = [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 },
  offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: 'NORMAL' }];
\`\`\`

### Auto-layout children
\`\`\`js
child.layoutSizingHorizontal = "FILL"; // "FIXED" | "HUG" | "FILL"
child.layoutSizingVertical = "HUG";
child.layoutGrow = 1; // 0 = fixed, 1 = fill
// Do NOT set .x / .y on auto-layout children
\`\`\`

### Common gotchas
${GUARDIAN_FIGMA_EXECUTE_RULES}
`

// ---------------------------------------------------------------------------
// Full docs — fetch from developers.figma.com
// ---------------------------------------------------------------------------

const TOPIC_TO_PATH: Record<string, string> = {
  figma: "figma",
  FrameNode: "FrameNode", RectangleNode: "RectangleNode",
  EllipseNode: "EllipseNode", TextNode: "TextNode",
  PolygonNode: "PolygonNode", StarNode: "StarNode",
  LineNode: "LineNode", VectorNode: "VectorNode",
  GroupNode: "GroupNode", ComponentNode: "ComponentNode",
  InstanceNode: "InstanceNode", SectionNode: "SectionNode",
  PageNode: "PageNode", ComponentSetNode: "ComponentSetNode",
  BooleanOperationNode: "BooleanOperationNode",
  ConnectorNode: "ConnectorNode", StickyNode: "StickyNode",
  TableNode: "TableNode", SliceNode: "SliceNode", MediaNode: "MediaNode",
}

export async function fetchFigmaDocsFromWeb(
  topic: string,
  timeoutMs = 15_000
): Promise<{ success: boolean; content?: string; error?: string }> {
  const path = TOPIC_TO_PATH[topic] ?? topic
  const url = `https://developers.figma.com/docs/plugins/api/${path}/`

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "text/html" },
    })

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status} for ${url}` }
    }

    const html = await response.text()
    const text = html
      // Remove non-content blocks
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      // Convert structural HTML to markdown
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
      .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/td>/gi, " | ")
      .replace(/<\/th>/gi, " | ")
      // Strip remaining tags
      .replace(/<[^>]+>/g, "")
      // Decode common HTML entities
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, " ")
      // Clean up whitespace (preserve newlines)
      .replace(/[ \t]+/g, " ")
      .replace(/\n /g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 8000)

    return { success: true, content: `[Figma Plugin API — ${topic}]\n${text}` }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}
