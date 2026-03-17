/**
 * Fetch Figma Plugin API docs from developers.figma.com and strip HTML.
 *
 * Shared between the Temporal activity (agent orchestration) and the
 * Guardian MCP tool (interactive clients).
 */

const TOPIC_TO_PATH: Record<string, string> = {
  figma: "figma",
  FrameNode: "FrameNode",
  RectangleNode: "RectangleNode",
  EllipseNode: "EllipseNode",
  TextNode: "TextNode",
  PolygonNode: "PolygonNode",
  StarNode: "StarNode",
  LineNode: "LineNode",
  VectorNode: "VectorNode",
  GroupNode: "GroupNode",
  ComponentNode: "ComponentNode",
  InstanceNode: "InstanceNode",
  SectionNode: "SectionNode",
  PageNode: "PageNode",
  ComponentSetNode: "ComponentSetNode",
  BooleanOperationNode: "BooleanOperationNode",
  ConnectorNode: "ConnectorNode",
  StickyNode: "StickyNode",
  TableNode: "TableNode",
  SliceNode: "SliceNode",
  MediaNode: "MediaNode",
};

export async function fetchFigmaDocsFromWeb(
  topic: string,
  timeoutMs = 15_000
): Promise<{ success: boolean; content?: string; error?: string }> {
  const path = TOPIC_TO_PATH[topic] ?? topic;
  const url = `https://developers.figma.com/docs/plugins/api/${path}/`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "text/html" },
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status} for ${url}` };
    }

    const html = await response.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000);

    return { success: true, content: `[Figma Plugin API — ${topic}]\n${text}` };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
