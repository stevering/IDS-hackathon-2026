"use client";

import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { fixUnpairedMarkdown } from "@/lib/markdown-utils";
import { markdownComponents } from "./markdown-components";

function handleStreamingCharAnimationEnd(e: React.AnimationEvent<HTMLSpanElement>) {
  if (e.animationName === "streaming-char-in") return;
  e.currentTarget.classList.remove("streaming-char", "streaming-punct");
}

const PUNCT_PULSE = new Set([".", ",", ";", ":", "!", "?", "—", "–", "…", ")"]);

const FRESH_TAIL_MIN = 600;

function computeSplitAt(content: string): number {
  if (content.length <= FRESH_TAIL_MIN) return 0;
  const maxSplit = content.length - FRESH_TAIL_MIN;
  const idx = content.lastIndexOf("\n\n", maxSplit);
  return idx > 0 ? idx + 2 : 0;
}

const MemoStableMarkdown = memo(function MemoStableMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={markdownComponents}
    >
      {fixUnpairedMarkdown(content)}
    </ReactMarkdown>
  );
});

const freshProcessor = unified().use(remarkParse).use(remarkGfm);

const noWrapStyle = { whiteSpace: "nowrap" as const };

// Iterate by grapheme cluster so emojis (surrogate pairs, ZWJ sequences, skin-tone
// modifiers) and combining marks stay intact instead of splitting into U+FFFD � spans.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function renderStreamingText(text: string, absoluteOffset: number): ReactNode {
  const nodes: ReactNode[] = [];
  let wordChars: ReactNode[] = [];
  let wordStart = -1;

  const flushWord = () => {
    if (wordStart === -1) return;
    nodes.push(
      <span key={`w-${absoluteOffset + wordStart}`} style={noWrapStyle}>{wordChars}</span>
    );
    wordChars = [];
    wordStart = -1;
  };

  for (const { segment: ch, index: j } of graphemeSegmenter.segment(text)) {
    if (ch === " " || ch === "\t" || ch === "\n") {
      flushWord();
      if (ch === "\n") {
        nodes.push(<br key={`br-${absoluteOffset + j}`} />);
      } else {
        nodes.push(ch);
      }
      continue;
    }
    if (wordStart === -1) wordStart = j;
    const abs = absoluteOffset + j;
    wordChars.push(
      <span
        key={`c-${abs}`}
        className={PUNCT_PULSE.has(ch) ? "streaming-char streaming-punct" : "streaming-char"}
        onAnimationEnd={handleStreamingCharAnimationEnd}
      >
        {ch}
      </span>
    );
  }
  flushWord();

  return <>{nodes}</>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMdastNode(node: any, offsetBase: number): ReactNode {
  const pos = node.position?.start?.offset ?? 0;
  const absolute = offsetBase + pos;
  const key = `${node.type}-${absolute}`;

  const renderChildren = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node.children ?? []).map((c: any) => renderMdastNode(c, offsetBase));

  switch (node.type) {
    case "text":
      return renderStreamingText(node.value, absolute);
    case "paragraph":
      return <p key={key}>{renderChildren()}</p>;
    case "heading": {
      const Tag = `h${node.depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag key={key}>{renderChildren()}</Tag>;
    }
    case "strong":
      return <strong key={key}>{renderChildren()}</strong>;
    case "emphasis":
      return <em key={key}>{renderChildren()}</em>;
    case "delete":
      return <del key={key}>{renderChildren()}</del>;
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "code":
      return (
        <pre key={key}>
          <code>{node.value}</code>
        </pre>
      );
    case "link":
      return (
        <a key={key} href={node.url} target="_blank" rel="noopener noreferrer">
          {renderChildren()}
        </a>
      );
    case "list": {
      const ListTag = node.ordered ? "ol" : "ul";
      return <ListTag key={key}>{renderChildren()}</ListTag>;
    }
    case "listItem":
      return <li key={key}>{renderChildren()}</li>;
    case "blockquote":
      return <blockquote key={key}>{renderChildren()}</blockquote>;
    case "break":
      return <br key={key} />;
    case "thematicBreak":
      return <hr key={key} />;
    case "table": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (node.children ?? []) as any[];
      const [headerRow, ...bodyRows] = rows;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const align: (string | null | undefined)[] = node.align ?? [];
      const cellStyle = (i: number) =>
        align[i] ? { textAlign: align[i] as "left" | "right" | "center" } : undefined;
      return (
        <table key={key}>
          {headerRow && (
            <thead>
              <tr>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {(headerRow.children ?? []).map((cell: any, i: number) => {
                  const cpos = cell.position?.start?.offset ?? 0;
                  return (
                    <th key={`th-${offsetBase + cpos}`} style={cellStyle(i)}>
                      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                      {(cell.children ?? []).map((c: any) => renderMdastNode(c, offsetBase))}
                    </th>
                  );
                })}
              </tr>
            </thead>
          )}
          {bodyRows.length > 0 && (
            <tbody>
              {bodyRows.map((row) => {
                const rpos = row.position?.start?.offset ?? 0;
                return (
                  <tr key={`tr-${offsetBase + rpos}`}>
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {(row.children ?? []).map((cell: any, i: number) => {
                      const cpos = cell.position?.start?.offset ?? 0;
                      return (
                        <td key={`td-${offsetBase + cpos}`} style={cellStyle(i)}>
                          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                          {(cell.children ?? []).map((c: any) => renderMdastNode(c, offsetBase))}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      );
    }
    default:
      if (typeof node.value === "string") {
        return renderStreamingText(node.value, absolute);
      }
      if (node.children) {
        return <span key={key}>{renderChildren()}</span>;
      }
      return null;
  }
}

function FreshMarkdownRenderer({ content, offsetBase }: { content: string; offsetBase: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tree = freshProcessor.parse(content) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <>{(tree.children ?? []).map((n: any) => renderMdastNode(n, offsetBase))}</>;
}

export function StreamingMarkdown({ content }: { content: string }) {
  const fixed = fixUnpairedMarkdown(content);
  const splitAt = computeSplitAt(fixed);
  const stable = splitAt > 0 ? fixed.slice(0, splitAt) : "";
  const fresh = splitAt > 0 ? fixed.slice(splitAt) : fixed;

  return (
    <>
      {stable && <MemoStableMarkdown content={stable} />}
      {fresh && <FreshMarkdownRenderer content={fresh} offsetBase={splitAt} />}
    </>
  );
}
