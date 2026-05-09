import { cleanOrphanedTags } from "./markdown-utils";

export type ContentSegment = { kind: "content"; text: string };
export type DetailsSegment = { kind: "details"; text: string; streaming: boolean };
/**
 * Optional QCM_META carried in an HTML comment inside the QCM block. When the
 * LLM emits target-disambiguation choices, the meta maps each rendered label
 * back to a TargetSelector id ("plugin:<clientId>" or "instance:<uuid>") so a
 * click can update React state in addition to sending the choice text as a
 * new user message. Format:
 *   <!-- QCM_META: {"category":"design","map":{"Mereku (File A)":"plugin:abc",...}} -->
 */
export type QCMMeta = {
  category: "design" | "code";
  map: Record<string, string>;
};
export type QCMSegment = { kind: "qcm"; choices: string[]; meta?: QCMMeta };
export type MCPErrorSegment = { kind: "mcp-error"; errorText: string };
export type MCPStatusSegment = { kind: "mcp-status"; status: "connecting" | "connected" | "error" };
export type AnalyzeBtnSegment = { kind: "analyze-btn" };
export type OrchestrateBtnSegment = { kind: "orchestrate-btn"; agents: string[] };
export type StructuredSegment = ContentSegment | DetailsSegment | QCMSegment | MCPErrorSegment | MCPStatusSegment | AnalyzeBtnSegment | OrchestrateBtnSegment;

export type TextSegment = { type: "text"; content: string };
export type ImageSegment = { type: "image"; src: string; complete: boolean };
export type Segment = TextSegment | ImageSegment;

export function parseStructuredContent(text: string, isStreamingMsg: boolean = false): StructuredSegment[] {
  const segments: StructuredSegment[] = [];

  let cleanedText = text;
  if (!isStreamingMsg) {
    cleanedText = cleanOrphanedTags(text);
  }

  const detailsRegex = /(?:```\s*)?<!-- DETAILS_START -->([\s\S]*?)<!-- DETAILS_END -->(?:\s*```)?/g;

  const detailsBlocks: { index: number; length: number; text: string; streaming: boolean }[] = [];
  const qcmBlocks: { index: number; length: number; choices: string[]; meta?: QCMMeta }[] = [];
  const mcpErrorBlocks: { index: number; length: number; errorText: string }[] = [];
  const mcpStatusBlocks: { index: number; length: number; status: "connecting" | "connected" | "error" }[] = [];

  let match;
  while ((match = detailsRegex.exec(cleanedText)) !== null) {
    detailsBlocks.push({ index: match.index, length: match[0].length, text: match[1].trim(), streaming: false });
  }

  const qcmRegex = /<!-- QCM_START -->([\s\S]*?)<!-- QCM_END -->/g;
  const qcmMetaRegex = /<!--\s*QCM_META:\s*(\{[\s\S]*?\})\s*-->/;
  while ((match = qcmRegex.exec(cleanedText)) !== null) {
    const inner = match[1];
    let meta: QCMMeta | undefined;
    const metaMatch = qcmMetaRegex.exec(inner);
    if (metaMatch) {
      try {
        const parsed = JSON.parse(metaMatch[1]) as QCMMeta;
        if (parsed && typeof parsed === "object" && parsed.map && typeof parsed.map === "object") {
          meta = parsed;
        }
      } catch {
        // Malformed QCM_META — ignore, choices still render.
      }
    }
    const choices = inner
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.startsWith("- [CHOICE] "))
      .map(l => l.replace("- [CHOICE] ", ""));
    if (choices.length > 0) {
      qcmBlocks.push({ index: match.index, length: match[0].length, choices, meta });
    }
  }

  const analyzeBtnBlocks: { index: number; length: number }[] = [];
  const analyzeBtnRegex = /\[ANALYZE_BTN\]/g;
  while ((match = analyzeBtnRegex.exec(cleanedText)) !== null) {
    analyzeBtnBlocks.push({ index: match.index, length: match[0].length });
  }

  const orchestrateBtnBlocks: { index: number; length: number; agents: string[] }[] = [];
  const orchestrateRegex = /\[ORCHESTRATE:([\w#,\-\s]+)\]/g;
  while ((match = orchestrateRegex.exec(cleanedText)) !== null) {
    const agents = match[1].split(",").map(a => a.trim()).filter(Boolean);
    if (agents.length > 0) {
      orchestrateBtnBlocks.push({ index: match.index, length: match[0].length, agents });
    }
  }

  const mcpErrorRegex = /\[MCP_ERROR_BLOCK\]([\s\S]*?)\[\/MCP_ERROR_BLOCK\]/g;
  while ((match = mcpErrorRegex.exec(cleanedText)) !== null) {
    mcpErrorBlocks.push({ index: match.index, length: match[0].length, errorText: match[1].trim() });
  }

  const mcpStatusRegex = /\[MCP_STATUS:(\w+)\]/g;
  let lastMcpStatus: { index: number; length: number; status: "connecting" | "connected" | "error" } | null = null;
  while ((match = mcpStatusRegex.exec(cleanedText)) !== null) {
    const status = match[1] as "connecting" | "connected" | "error";
    lastMcpStatus = { index: match.index, length: match[0].length, status };
  }
  if (lastMcpStatus) {
    mcpStatusBlocks.push(lastMcpStatus);
  }

  cleanedText = cleanedText
    .replace(/\[MCP_STATUS:\w+\]/g, "")
    .replace(/\[MCP_ERROR_BLOCK\][\s\S]*?\[\/MCP_ERROR_BLOCK\]/g, "")
    .replace(/\[AGENT_DONE:[^\]]*\]/g, "");

  if (isStreamingMsg) {
    const openTag = "<!-- DETAILS_START -->";
    const allCompleteEnds = [...cleanedText.matchAll(/<!-- DETAILS_END -->/g)].map(m => m.index!);
    const lastOpenIdx = cleanedText.lastIndexOf(openTag);
    if (lastOpenIdx !== -1) {
      const hasMatchingClose = allCompleteEnds.some(endIdx => endIdx > lastOpenIdx);
      if (!hasMatchingClose) {
        const contentStart = lastOpenIdx + openTag.length;
        const partialText = cleanedText.slice(contentStart).replace(/^```\s*/, "").trim();
        detailsBlocks.push({ index: lastOpenIdx, length: cleanedText.length - lastOpenIdx, text: partialText, streaming: true });
      }
    }
  }

  const allBlocks = [
    ...detailsBlocks.map(b => ({ ...b, kind: "details" as const })),
    ...qcmBlocks.map(b => ({ ...b, kind: "qcm" as const, streaming: false })),
    ...mcpErrorBlocks.map(b => ({ ...b, kind: "mcp-error" as const, streaming: false })),
    ...analyzeBtnBlocks.map(b => ({ ...b, kind: "analyze-btn" as const, streaming: false })),
    ...orchestrateBtnBlocks.map(b => ({ ...b, kind: "orchestrate-btn" as const, streaming: false })),
  ].sort((a, b) => a.index - b.index);

  if (allBlocks.length === 0) {
    if (cleanedText.trim()) segments.push({ kind: "content", text: cleanedText });
    return segments;
  }

  let cursor = 0;
  for (const block of allBlocks) {
    if (block.index > cursor) {
      const content = cleanedText.slice(cursor, block.index).trim();
      if (content) segments.push({ kind: "content", text: content });
    }
    if (block.kind === "details") {
      segments.push({ kind: "details", text: block.text, streaming: block.streaming });
    } else if (block.kind === "qcm") {
      const qcmBlock = block as typeof qcmBlocks[number] & { kind: "qcm" };
      segments.push({ kind: "qcm", choices: qcmBlock.choices, meta: qcmBlock.meta });
    } else if (block.kind === "mcp-error") {
      segments.push({ kind: "mcp-error", errorText: (block as typeof mcpErrorBlocks[number] & { kind: "mcp-error" }).errorText });
    } else if (block.kind === "analyze-btn") {
      segments.push({ kind: "analyze-btn" });
    } else if (block.kind === "orchestrate-btn") {
      segments.push({ kind: "orchestrate-btn", agents: (block as typeof orchestrateBtnBlocks[number] & { kind: "orchestrate-btn" }).agents });
    }
    cursor = block.index + block.length;
  }
  if (cursor < cleanedText.length) {
    const remaining = cleanedText.slice(cursor).trim();
    if (remaining) segments.push({ kind: "content", text: remaining });
  }

  if (lastMcpStatus) {
    segments.unshift({ kind: "mcp-status", status: lastMcpStatus.status });
  }

  return segments;
}

export function parseTextWithImages(text: string, isStreaming: boolean): Segment[] {
  const regex = /(data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]*)/g;
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    const src = match[1];
    const isLast = regex.lastIndex >= text.length || text.slice(regex.lastIndex).trim() === "";
    const complete = !(isStreaming && isLast);
    segments.push({ type: "image", src, complete });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }

  return segments;
}
