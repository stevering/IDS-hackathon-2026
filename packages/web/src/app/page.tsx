"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import type { GatewayModel } from "./api/gateway-models/route";
import { useFigmaPlugin } from "./hooks/useFigmaPlugin";
import { useFigmaExecuteChannel } from "./hooks/useFigmaExecuteChannel";
import { useClientRegistry } from "./hooks/useClientRegistry";
import { TargetSelector, type TargetItem } from "@/components/TargetSelector";
import { UserMenu } from "@/components/UserMenu";
import { EditableClientId } from "@/components/EditableClientId";
import { GlassDropdown } from "@/components/GlassDropdown";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { useConversations } from "./hooks/useConversations";
import { useMessagePersistence } from "./hooks/useMessagePersistence";
import { useOrchestration, type OrchestrationCallbacks, type CollaboratorInfo } from "./hooks/useOrchestration";
import type { AgentRole, Orchestration } from "@/types/orchestration";
import { ConversationSwitcher } from "@/components/ConversationSwitcher";
import { OrchestrationStatusBar } from "@/components/OrchestrationStatusBar";
import { OrchestrationInviteModal } from "@/components/OrchestrationInviteModal";
import { AgentMessageBubble } from "@/components/AgentMessageBubble";
import { MentionAutocomplete, type MentionSuggestion, parseMentions } from "@/components/MentionAutocomplete";
import { AutoAcceptToggle } from "@/components/AutoAcceptToggle";

type TextSegment = { type: "text"; content: string };
type ImageSegment = { type: "image"; src: string; complete: boolean };
type Segment = TextSegment | ImageSegment;

type ThinkingSegment = { kind: "thinking"; text: string };
type ContentSegment = { kind: "content"; text: string };
type DetailsSegment = { kind: "details"; text: string; streaming: boolean };
type QCMSegment = { kind: "qcm"; choices: string[] };
type MCPErrorSegment = { kind: "mcp-error"; errorText: string };
type MCPStatusSegment = { kind: "mcp-status"; status: "connecting" | "connected" | "error" };
type AnalyzeBtnSegment = { kind: "analyze-btn" };
type OrchestrateBtnSegment = { kind: "orchestrate-btn"; agents: string[] };
type StructuredSegment = ThinkingSegment | ContentSegment | DetailsSegment | QCMSegment | MCPErrorSegment | MCPStatusSegment | AnalyzeBtnSegment | OrchestrateBtnSegment;

const markdownComponents: Components = {
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
};

function ThinkingBlock({ text, isLast, isStreaming }: { text: string; isLast: boolean; isStreaming: boolean }) {
  const [open, setOpen] = useState(false);
  const isActive = isLast && isStreaming;

  return (
    <div className="my-2">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-md transition-colors w-full text-left overflow-hidden min-w-0 cursor-pointer ${
          isActive
            ? "bg-violet-500/10 border border-violet-500/20 text-violet-300"
            : "bg-white/5 border border-white/5 text-white/40 hover:bg-white/10"
        }`}
      >
        {isActive ? (
          <svg className="animate-spin h-3 w-3 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="currentColor">
            <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
          </svg>
        )}
        <span className="font-medium shrink-0">{isActive ? "Thinking..." : "Thought"}</span>
        {!isActive && !open && <span className="truncate opacity-60 min-w-0">{text.slice(0, 80)}{text.length > 80 ? "…" : ""}</span>}
      </button>
      {(open || isActive) && (
        <div className={`mt-1 ml-5 px-3 py-2 rounded text-xs leading-relaxed border-l-2 ${
          isActive ? "border-violet-500/30 text-violet-200/70" : "border-white/10 text-white/40"
        }`}>
          {text}
        </div>
      )}
    </div>
  );
}

function DetailsBlock({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [open, setOpen] = useState(false);
  const detailsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && isStreaming && detailsEndRef.current) {
      detailsEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [open, isStreaming, text]);

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs px-3 py-2 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-300 hover:bg-blue-500/20 transition-colors cursor-pointer"
      >
        {isStreaming && !open ? (
          <svg className="animate-spin h-3 w-3 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="currentColor">
            <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
          </svg>
        )}
        <span className="font-medium">{open ? "Hide details" : "More details"}</span>
        {isStreaming && !open && <span className="text-blue-400/60 text-[10px] ml-1">streaming…</span>}
      </button>
      {open && (
        <div className="mt-2 px-3 py-3 rounded-md bg-white/[0.03] border border-white/5 text-sm overflow-x-auto markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{text}</ReactMarkdown>
          <div ref={detailsEndRef} />
        </div>
      )}
    </div>
  );
}

function QCMBlock({ choices, onSelect, disabled }: { choices: string[]; onSelect: (choice: string) => void; disabled: boolean }) {
  return (
    <div className="my-3 flex flex-wrap gap-2">
      {choices.map((choice, i) => (
        <button
          key={i}
          onClick={() => !disabled && onSelect(choice)}
          disabled={disabled}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
            disabled
              ? "bg-white/5 border-white/10 text-white/30 cursor-not-allowed"
              : "bg-blue-600/20 border-blue-500/30 text-blue-300 hover:bg-blue-600/30 hover:border-blue-500/50 cursor-pointer"
          }`}
        >
          {choice}
        </button>
      ))}
    </div>
  );
}

function parseStructuredContent(text: string, isStreamingMsg: boolean = false): StructuredSegment[] {
  const segments: StructuredSegment[] = [];

  // Clean orphaned tags before parsing (outside streaming)
  let cleanedText = text;
  if (!isStreamingMsg) {
    cleanedText = cleanOrphanedTags(text);
  }

  const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
  const detailsRegex = /(?:```\s*)?<!-- DETAILS_START -->([\s\S]*?)<!-- DETAILS_END -->(?:\s*```)?/g;

  const thinkingBlocks: { index: number; length: number; text: string }[] = [];
  const detailsBlocks: { index: number; length: number; text: string; streaming: boolean }[] = [];
  const qcmBlocks: { index: number; length: number; choices: string[] }[] = [];
  const mcpErrorBlocks: { index: number; length: number; errorText: string }[] = [];
  const mcpStatusBlocks: { index: number; length: number; status: "connecting" | "connected" | "error" }[] = [];

  let match;
  while ((match = thinkingRegex.exec(cleanedText)) !== null) {
    thinkingBlocks.push({ index: match.index, length: match[0].length, text: match[1].trim() });
  }
  while ((match = detailsRegex.exec(cleanedText)) !== null) {
    detailsBlocks.push({ index: match.index, length: match[0].length, text: match[1].trim(), streaming: false });
  }

  const qcmRegex = /<!-- QCM_START -->([\s\S]*?)<!-- QCM_END -->/g;
  while ((match = qcmRegex.exec(cleanedText)) !== null) {
    const choices = match[1]
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.startsWith("- [CHOICE] "))
      .map(l => l.replace("- [CHOICE] ", ""));
    if (choices.length > 0) {
      qcmBlocks.push({ index: match.index, length: match[0].length, choices });
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

  // Parse MCP statuses - keep only the last one
  const mcpStatusRegex = /\[MCP_STATUS:(\w+)\]/g;
  let lastMcpStatus: { index: number; length: number; status: "connecting" | "connected" | "error" } | null = null;
  while ((match = mcpStatusRegex.exec(cleanedText)) !== null) {
    const status = match[1] as "connecting" | "connected" | "error";
    lastMcpStatus = { index: match.index, length: match[0].length, status };
  }
  if (lastMcpStatus) {
    mcpStatusBlocks.push(lastMcpStatus);
  }

  // Remove MCP tags from text to avoid displaying them
  cleanedText = cleanedText
    .replace(/\[MCP_STATUS:\w+\]/g, "")
    .replace(/\[MCP_ERROR_BLOCK\][\s\S]*?\[\/MCP_ERROR_BLOCK\]/g, "");

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
    ...thinkingBlocks.map(b => ({ ...b, kind: "thinking" as const, streaming: false })),
    ...detailsBlocks.map(b => ({ ...b, kind: "details" as const })),
    ...qcmBlocks.map(b => ({ ...b, kind: "qcm" as const, streaming: false })),
    ...mcpErrorBlocks.map(b => ({ ...b, kind: "mcp-error" as const, streaming: false })),
    ...mcpStatusBlocks.map(b => ({ ...b, kind: "mcp-status" as const, streaming: false })),
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
      segments.push({ kind: "qcm", choices: (block as typeof qcmBlocks[number] & { kind: "qcm" }).choices });
    } else if (block.kind === "mcp-error") {
      segments.push({ kind: "mcp-error", errorText: (block as typeof mcpErrorBlocks[number] & { kind: "mcp-error" }).errorText });
    } else if (block.kind === "mcp-status") {
      segments.push({ kind: "mcp-status", status: (block as typeof mcpStatusBlocks[number] & { kind: "mcp-status" }).status });
    } else if (block.kind === "analyze-btn") {
      segments.push({ kind: "analyze-btn" });
    } else if (block.kind === "orchestrate-btn") {
      segments.push({ kind: "orchestrate-btn", agents: (block as typeof orchestrateBtnBlocks[number] & { kind: "orchestrate-btn" }).agents });
    } else {
      segments.push({ kind: block.kind, text: (block as { text: string }).text });
    }
    cursor = block.index + block.length;
  }
  if (cursor < cleanedText.length) {
    const remaining = cleanedText.slice(cursor).trim();
    if (remaining) segments.push({ kind: "content", text: remaining });
  }

  return segments;
}

/**
 * Removes orphaned tags (opening without closing or closing without opening)
 * to prevent them from being displayed in the chat.
 */
function cleanOrphanedTags(text: string): string {
  let cleaned = text;

  // Detect DETAILS_START tags without closing
  const detailsOpens = [...cleaned.matchAll(/<!-- DETAILS_START -->/g)];
  const detailsCloses = [...cleaned.matchAll(/<!-- DETAILS_END -->/g)].map(m => m.index!);

  for (const match of detailsOpens) {
    const openIdx = match.index!;
    const hasMatchingClose = detailsCloses.some(closeIdx => closeIdx > openIdx);
    if (!hasMatchingClose) {
      // Remove the orphaned opening tag
      cleaned = cleaned.replace(/<!-- DETAILS_START -->/, "");
    }
  }

  // Detect DETAILS_END tags without opening
  const detailsOpensAfterClean = [...cleaned.matchAll(/<!-- DETAILS_START -->/g)].map(m => m.index!);
  const detailsClosesAfterClean = [...cleaned.matchAll(/<!-- DETAILS_END -->/g)];

  for (const match of detailsClosesAfterClean) {
    const closeIdx = match.index!;
    const hasMatchingOpen = detailsOpensAfterClean.some(openIdx => openIdx < closeIdx);
    if (!hasMatchingOpen) {
      // Remove the orphaned closing tag
      cleaned = cleaned.replace(/<!-- DETAILS_END -->/, "");
    }
  }

  // Detect QCM_START tags without closing
  const qcmOpens = [...cleaned.matchAll(/<!-- QCM_START -->/g)];
  const qcmCloses = [...cleaned.matchAll(/<!-- QCM_END -->/g)].map(m => m.index!);

  for (const match of qcmOpens) {
    const openIdx = match.index!;
    const hasMatchingClose = qcmCloses.some(closeIdx => closeIdx > openIdx);
    if (!hasMatchingClose) {
      // Remove the orphaned opening tag and its content until the end
      cleaned = cleaned.replace(/<!-- QCM_START -->[\s\S]*$/, "");
    }
  }

  // Detect QCM_END tags without opening
  const qcmOpensAfterClean = [...cleaned.matchAll(/<!-- QCM_START -->/g)].map(m => m.index!);
  const qcmClosesAfterClean = [...cleaned.matchAll(/<!-- QCM_END -->/g)];

  for (const match of qcmClosesAfterClean) {
    const closeIdx = match.index!;
    const hasMatchingOpen = qcmOpensAfterClean.some(openIdx => openIdx < closeIdx);
    if (!hasMatchingOpen) {
      // Remove the orphaned closing tag
      cleaned = cleaned.replace(/<!-- QCM_END -->/, "");
    }
  }

  return cleaned.trim();
}

function ToolCallBlock({ toolName, input, output, isError }: { toolName: string; input?: Record<string, unknown>; output?: unknown; isError?: boolean }) {
  const [open, setOpen] = useState(false);
  const [visibleLines, setVisibleLines] = useState(50);
  const CHUNK = 50;

  const outputText = (() => {
    if (!output) return null;
    if (typeof output === "string") return output;
    const o = output as { content?: { type: string; text: string }[] };
    if (o.content && Array.isArray(o.content)) {
      return o.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    }
    return JSON.stringify(output, null, 2);
  })();

  const outputLines = outputText ? outputText.split("\n") : [];
  const totalLines = outputLines.length;
  const hasMore = totalLines > visibleLines;
  const displayedText = totalLines > CHUNK ? outputLines.slice(0, visibleLines).join("\n") : outputText;

  // For web_search, indicate that the search is done automatically by the model
  const isWebSearch = toolName === "web_search";
  const hasInput = input && Object.keys(input).length > 0;

  return (
    <div className="my-2">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-md transition-colors w-full text-left overflow-hidden min-w-0 cursor-pointer ${
          isError
            ? "bg-red-500/5 border border-red-500/15 text-red-300/70 hover:bg-red-500/10"
            : "bg-white/5 border border-white/5 text-white/50 hover:bg-white/10"
        }`}
      >
        <svg className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
        </svg>
        <span className="text-amber-400/70">🔧 Tool:</span>
        <span className="font-medium">{toolName}</span>
        {isError ? (
          <span className="text-red-400/70">✗</span>
        ) : (
          <span className="text-emerald-400/70">✓</span>
        )}
        {!open && hasInput && (
          <span className="truncate opacity-50 font-mono text-[10px] ml-1 min-w-0 flex-1">
            {Object.entries(input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ").slice(0, 40)}
          </span>
        )}
        {!open && isWebSearch && !hasInput && (
          <span className="truncate opacity-40 text-[10px] ml-1 min-w-0 flex-1 italic">
            Automatic web search
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 ml-5 space-y-2">
          {isWebSearch && !hasInput && (
            <div className="px-3 py-2 rounded text-xs leading-relaxed border-l-2 border-blue-500/20">
              <span className="text-white/30 font-medium block mb-1">Info:</span>
              <p className="text-blue-200/50">
                Web search is performed automatically by the AI model.
                Search terms are not exposed by the API.
              </p>
            </div>
          )}
          {hasInput && (
            <div className="px-3 py-2 rounded text-xs leading-relaxed border-l-2 border-amber-500/20">
              <span className="text-white/30 font-medium block mb-1">Input:</span>
              <pre className="text-amber-200/50 font-mono whitespace-pre-wrap break-all">{JSON.stringify(input, null, 2)}</pre>
            </div>
          )}
          {outputText && (
            <div className={`px-3 py-2 rounded text-xs leading-relaxed border-l-2 ${isError ? "border-red-500/20" : "border-emerald-500/20"}`}>
              <span className="text-white/30 font-medium block mb-1">Output{isError ? " (error)" : ""}:</span>
              <pre className={`font-mono whitespace-pre-wrap break-all ${isError ? "text-red-300/50" : "text-emerald-200/50"}`}>{displayedText}</pre>
              {hasMore && (
                <button
                  onClick={() => setVisibleLines((v) => v + CHUNK)}
                  className="mt-2 text-[11px] text-blue-400/80 hover:text-blue-300 transition-colors cursor-pointer"
                >
                  more ({visibleLines}/{totalLines} lines)
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallProgress({ toolName }: { toolName: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = minutes > 0
    ? `${minutes}m ${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;

  const isStalled = elapsed >= 15;

  return (
    <div className={`my-2 px-3 py-2 rounded text-xs font-mono flex items-center gap-2 ${
      isStalled ? "bg-amber-500/10 border border-amber-500/20 text-amber-300/70" : "bg-white/5 text-white/50"
    }`}>
      <svg className="animate-spin h-3.5 w-3.5 text-amber-400/70 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <span className="text-amber-400/70">🔧 Tool:</span>{" "}
      {toolName}
      {isStalled && <span className="text-amber-400/60 text-[10px]">slow response…</span>}
      <span className={`ml-auto tabular-nums ${isStalled ? "text-amber-400/50" : "text-white/30"}`}>{timeStr}</span>
    </div>
  );
}

function MCPStatusBlock({ status }: { status: "connecting" | "connected" | "error" }) {
  const [phase, setPhase] = useState<'mounting' | 'entering' | 'entered' | 'exiting' | 'unmounted'>('mounting');
  const [localStatus, setLocalStatus] = useState<"connecting" | "error">(status as any);
  const mountTimeRef = useRef(Date.now());

  useEffect(() => {
    if (status === "connected") {
      const totalDisplayMin = 1500; // Min 1.5s visible
      const elapsed = Date.now() - mountTimeRef.current;
      const delayHide = Math.max(0, totalDisplayMin - elapsed);
      const timer = setTimeout(() => {
        setPhase('exiting');
        const fadeTimer = setTimeout(() => setPhase('unmounted'), 400);
        return () => clearTimeout(fadeTimer);
      }, delayHide);
      return () => clearTimeout(timer);
    } else {
      // Fade in sequence
      setPhase('entering');
      setTimeout(() => setPhase('entered'), 150); // Fade in 150ms
      setLocalStatus(status);
      mountTimeRef.current = Date.now();
    }
  }, [status]);

  if (phase === 'unmounted' || phase === 'mounting') return null;

  const isError = localStatus === "error";
  const isEntering = phase === 'entering';
  const isExiting = phase === 'exiting';

  const transformClass = isEntering ? 'opacity-0 scale-95 translate-y-4' : 
                          isExiting ? 'opacity-0 scale-95 translate-y-2' : 
                          'opacity-100 scale-100 translate-y-0';

  return (
    <div className={`my-3 p-3 rounded-lg border transition-all duration-400 ease-out ${transformClass} ${isError ? "bg-red-500/5 border-red-500/20" : "bg-blue-500/5 border-blue-500/20"}`}>
      <div className="flex items-center gap-3">
        {isError ? (
          <svg className={`h-5 w-5 ${isEntering || isExiting ? 'opacity-70' : ''} text-red-400/70 shrink-0 transition-opacity`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ) : (
          <svg className={`animate-spin h-5 w-5 text-blue-400/70 shrink-0 transition-opacity ${isExiting ? "opacity-50" : ""}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        <div className="flex-1">
          <h4 className={`text-sm font-medium transition-all duration-300 ${isError ? "text-red-300/90" : "text-blue-300/90"} ${isEntering || isExiting ? "opacity-80" : "opacity-100"}`}>
            {isError ? "MCP Connection Failed" : "Connecting to MCP servers..."}
          </h4>
          <p className={`text-xs text-white/60 transition-all duration-300 ${isEntering || isExiting ? "opacity-70" : "opacity-100"}`}>
            {isError
              ? "Unable to connect to MCP servers. Some features may be unavailable."
              : "Please wait while we establish connection to Figma and Code MCP servers..."}
          </p>
        </div>
      </div>
    </div>
  );
}

function MCPErrorBlock({ errorText, onAskHelp }: { errorText: string; onAskHelp: () => void }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="my-3 p-4 rounded-lg bg-amber-500/5 border border-amber-500/20">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          <svg className="h-5 w-5 text-amber-400/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-amber-300/90 mb-1">MCP Connection Issue</h4>
          <p className="text-xs text-white/60 mb-3">
            I couldn't connect to some MCP servers. I won't be able to access your files or designs until this is resolved.
          </p>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-xs text-amber-400/70 hover:text-amber-300/90 transition-colors flex items-center gap-1 mb-3"
          >
            <svg className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="currentColor">
              <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
            </svg>
            {isExpanded ? "Hide details" : "Show details"}
          </button>

          {isExpanded && (
            <div className="mb-3 p-2.5 rounded bg-black/20 text-xs font-mono text-white/50 whitespace-pre-wrap break-all">
              {errorText}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={onAskHelp}
              className="px-3 py-1.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-xs font-medium transition-colors flex items-center gap-1.5"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Ask help for this
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = minutes > 0
    ? `${minutes}m ${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;

  return (
    <div className="mb-4">
      <div className="max-w-full sm:max-w-[80%] rounded-lg px-3 sm:px-4 py-3 glass-msg-ai">
        <div className="flex items-center gap-3 text-sm text-white/50">
          <div className="flex items-center gap-1.5">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
          </div>
          <span className="font-medium">Thinking</span>
          <span className="ml-auto tabular-nums text-white/30 text-xs">{timeStr}</span>
        </div>
      </div>
    </div>
  );
}

function parseTextWithImages(text: string, isStreaming: boolean): Segment[] {
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

/** Clipboard helper — falls back to execCommand for iframes without clipboard API */
function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
  }
  return execCommandCopy(text);
}

function execCommandCopy(text: string): Promise<void> {
  return new Promise((resolve) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    resolve();
  });
}

// ---------------------------------------------------------------------------
// CopyDebugButton — copies full debug context to clipboard
// ---------------------------------------------------------------------------
function CopyDebugButton({
  messages,
  clients,
  myClientId,
  myShortId,
  agentRole,
  orchestration,
  collaborators,
  activeConversationId,
  conversations,
}: {
  messages: { id: string; role: string; parts: { type: string; text?: string }[] }[];
  clients: { clientId: string; shortId: string; label: string; type: string; fileKey?: string; agentRole?: AgentRole; figmaContext?: { fileName?: string } }[];
  myClientId: string;
  myShortId: string;
  agentRole: AgentRole;
  orchestration: Orchestration | null;
  collaborators: CollaboratorInfo[];
  activeConversationId: string | null;
  conversations: { id: string; title: string; orchestration_id: string | null }[];
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const debugData = {
      timestamp: new Date().toISOString(),
      thisClient: { clientId: myClientId, shortId: myShortId, agentRole },
      orchestration: orchestration
        ? { id: orchestration.id, status: orchestration.status, orchestratorClientId: orchestration.orchestratorClientId, conversationId: orchestration.conversationId }
        : null,
      collaborators: collaborators.map(c => ({ clientId: c.clientId, shortId: c.shortId, label: c.label, status: c.status, task: c.task, conversationId: c.conversationId })),
      connectedClients: clients.map(c => ({ clientId: c.clientId, shortId: c.shortId, label: c.label, type: c.type, agentRole: c.agentRole, fileName: c.figmaContext?.fileName })),
      activeConversationId,
      conversations: conversations.map(c => ({ id: c.id, title: c.title, orchestrationId: c.orchestration_id })),
      messages: messages.map(m => ({
        id: m.id,
        role: m.role,
        text: m.parts
          .filter((p): p is { type: string; text: string } => p.type === "text" && !!p.text)
          .map(p => p.text)
          .join("\n")
          .slice(0, 2000) + (m.parts.some(p => p.type === "text" && (p.text?.length ?? 0) > 2000) ? "..." : ""),
        toolCalls: m.parts.filter(p => p.type?.startsWith?.("tool-") || p.type === "dynamic-tool").length || undefined,
      })),
    };

    const text = "```json\n" + JSON.stringify(debugData, null, 2) + "\n```";
    copyToClipboard(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex mt-1">
      <button
        onClick={handleCopy}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-white/15 hover:text-white/50 hover:bg-white/5 transition-colors cursor-pointer"
        title="Copy debug context to clipboard"
      >
        {copied ? (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Copied
          </>
        ) : (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            Debug
          </>
        )}
      </button>
    </div>
  );
}

export default function Home() {
  // ── Figma plugin bridge ─────────────────────────────────────────────
  const { isFigmaPlugin, figmaContext, sendToPlugin, executeCode } = useFigmaPlugin();
  const clientTypeForChannel: "figma-plugin" | "webapp" = isFigmaPlugin ? "figma-plugin" : "webapp";
  const clientLabel = (() => {
    if (typeof navigator === "undefined") return "Browser";
    const ua = navigator.userAgent;
    if (isFigmaPlugin) {
      // Figma Desktop uses an Electron-like shell (no Chrome/Firefox in UA)
      const isFigmaDesktop = /Figma/i.test(ua) || (!/Chrome|Firefox|Edg/i.test(ua) && /Safari/i.test(ua));
      return isFigmaDesktop ? "Figma-Desktop" : "Figma-Web";
    }
    return ua.split(" ").pop()?.split("/")[0] ?? "Browser";
  })();
  const clientFileKey = figmaContext?.fileKey ?? undefined;

  // When inside an iframe, wait for the Figma handshake before registering.
  // This avoids registering as "webapp/Safari" before isFigmaPlugin turns true.
  const isInIframe = typeof window !== "undefined" && window.parent !== window;
  const [iframeSettled, setIframeSettled] = useState(!isInIframe);
  useEffect(() => {
    if (!isInIframe) return;
    if (isFigmaPlugin) { setIframeSettled(true); return; }
    // Give the plugin handshake 500ms to complete, then settle as webapp
    const timer = setTimeout(() => setIframeSettled(true), 500);
    return () => clearTimeout(timer);
  }, [isInIframe, isFigmaPlugin]);

  // Get clientId from channel hook first, then register with server
  const [registryShortId, setRegistryShortId] = useState<string | null>(null);

  // Forward ref for orchestration callbacks — created early so it can be
  // passed to useFigmaExecuteChannel, then synced with the ref from
  // useOrchestration via a useEffect below.
  const orchestrationCallbacksFwdRef = useRef<OrchestrationCallbacks>({});

  const { clients, clientId: myClientId, channelRef } = useFigmaExecuteChannel(executeCode, true, {
    type: clientTypeForChannel,
    label: clientLabel,
    fileKey: clientFileKey,
    figmaContext: isFigmaPlugin && figmaContext ? {
      fileName: figmaContext.fileName,
      fileUrl: figmaContext.fileUrl,
      pages: figmaContext.pages,
      currentPage: figmaContext.currentPage,
      currentUser: figmaContext.currentUser,
    } : undefined,
    serverShortId: registryShortId,
  }, orchestrationCallbacksFwdRef);

  // Register client with the server-side registry (needs clientId from channel hook)
  // Wait for iframe detection to settle so we send the correct type/label
  const { shortId: serverShortId, rename: renameClient } = useClientRegistry(
    myClientId,
    clientTypeForChannel,
    clientLabel,
    clientFileKey,
    !!myClientId && iframeSettled,
  );

  // Sync server shortId to presence via state (avoids circular hook deps)
  useEffect(() => {
    if (serverShortId && serverShortId !== registryShortId) {
      setRegistryShortId(serverShortId);
    }
  }, [serverShortId, registryShortId]);

  // Use server-assigned shortId, falling back to presence-derived one
  const myDisplayShortId = registryShortId ?? clients.find(c => c.clientId === myClientId)?.shortId ?? myClientId;

  // ── Conversation persistence ────────────────────────────────────────
  const {
    conversations,
    activeConversation,
    activeConversationId,
    parallelConversations,
    createConversation,
    switchConversation,
    deleteConversation,
    updateTitle,
    loadConversations,
    ensureConversation,
  } = useConversations(myClientId, !!myClientId);

  // ── Collaborative Agents orchestration ──────────────────────────────
  const {
    role: agentRole,
    orchestration,
    collaborators,
    pendingInvites,
    settings: collabSettings,
    becomeOrchestrator,
    inviteCollaborator,
    sendAgentRequest,
    completeOrchestration,
    acceptInvite,
    declineInvite,
    sendAgentResponse,
    sendAgentMessage,
    updateSettings: updateCollabSettings,
    releaseRole,
    orchestrationCallbacksRef,
    onAgentRequest,
    onAgentResponse,
    onAgentMessage,
    onCollaboratorReady,
  } = useOrchestration(myClientId, myDisplayShortId, channelRef, !!myClientId);

  // Sync orchestration callbacks from useOrchestration into the forward
  // ref consumed by useFigmaExecuteChannel (avoids circular hook deps).
  useEffect(() => {
    Object.assign(orchestrationCallbacksFwdRef.current, orchestrationCallbacksRef.current);
  });

  const [selectedDesignTarget, setSelectedDesignTarget] = useState<string | null>(null);
  const [selectedCodeTarget, setSelectedCodeTarget] = useState<string | null>(null);



  const isDev = process.env.NODE_ENV === 'development';
  const [figmaMcpUrl, setFigmaMcpUrl] = useState(
      isDev ? process.env.NEXT_PUBLIC_PROXY_LOCAL_FIGMA_MCP : process.env.NEXT_PUBLIC_LOCAL_MCP_FIGMA_URL
  );
  const [codeProjectPath, setCodeProjectPath] = useState(
      isDev ? process.env.NEXT_PUBLIC_PROXY_LOCAL_CODE_MCP : process.env.NEXT_PUBLIC_LOCAL_MCP_CODE_URL
  );//"http://[::1]:3846/sse");
  const [figmaAccessToken, setFigmaAccessToken] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [figmaOAuth, setFigmaOAuth] = useState(false);
  const [southleftOAuth, setSouthleftOAuth] = useState(false);
  const [githubOAuth, setGithubOAuth] = useState(false);
  const [pendingAgentMessage, setPendingAgentMessage] = useState<string | null>(null);
  // Stable ref to sendMessage — declared early to be accessible in handleMessage
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendMessageEarlyRef = useRef<((msg: { text: string }) => void) | null>(null);
  const [input, setInput] = useState("");
  // selectedModel: "provider/model-id" for BYOK (e.g. "openai/gpt-4o"),
  // or legacy bare string for free-tier XAI (e.g. "grok-4-1-fast-non-reasoning")
  const [selectedModel, setSelectedModel] = useState<string>("grok-4-1-fast-non-reasoning");
  const [byokKeys, setByokKeys] = useState<{ provider: string; is_default: boolean }[]>([]);
  const [gatewayModels, setGatewayModels] = useState<GatewayModel[]>([]);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const [selectedNode, setSelectedNode] = useState<{ nodes: unknown[]; image: string | null; nodeUrl: string | null } | null>(null);
  const [figmaPluginContext, setFigmaPluginContext] = useState<{ fileKey: string; fileName: string; fileUrl: string; currentPage?: { id: string; name: string } | null; pages?: { id: string; name: string }[]; currentUser?: { id: string; name: string } | null } | null>(null);
  const [selectionGlow, setSelectionGlow] = useState(false);
  const [proxyModalOpen, setProxyModalOpen] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelSecret, setTunnelSecret] = useState(process.env.NEXT_PUBLIC_MCP_TUNNEL_SECRET);
  const [localFigmaMcpUrl, setLocalFigmaMcpUrl] = useState(process.env.NEXT_PUBLIC_LOCAL_MCP_FIGMA_URL || "");
  const [localCodeMcpUrl, setLocalCodeMcpUrl] = useState(process.env.NEXT_PUBLIC_LOCAL_MCP_CODE_URL || "");
  const [waitingForOAuth, setWaitingForOAuth] = useState(false);
  const [githubWaitingForOAuth, setGithubWaitingForOAuth] = useState(false);
  const [figmaWaitingForOAuth, setFigmaWaitingForOAuth] = useState(false);
  const githubOAuthSessionRef = useRef<string | null>(null);
  const figmaOAuthSessionRef = useRef<string | null>(null);

  // MCP Toggles - enabled/disabled state (lazy init from localStorage)
  const mcpDefaults = { figma: true, figmaConsole: false, github: false, code: true };
  const [enabledMcps, setEnabledMcps] = useState<Record<string, boolean>>(mcpDefaults);

  // Hydrate from localStorage after mount (avoids SSR/client mismatch)
  useEffect(() => {
    const saved = localStorage.getItem('guardian-enabled-mcps');
    if (saved) {
      try {
        setEnabledMcps(prev => ({ ...prev, ...JSON.parse(saved) }));
      } catch {
        // ignore malformed data
      }
    }
  }, []);

  // Toggle a single MCP and persist immediately (avoids race condition
  // where a save effect on mount would overwrite saved values with defaults)
  const toggleMcp = (key: string) => {
    setEnabledMcps(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('guardian-enabled-mcps', JSON.stringify(next));
      return next;
    });
  };

  // ── Client-side MCP reachability check ──────────────────────────────
  // URL-based MCPs: fetch via proxy (same-origin, no CORS).
  // OAuth MCPs: check localStorage tokens (instant).
  const [mcpReachable, setMcpReachable] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;

    async function pingUrl(url: string): Promise<boolean> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          method: "GET",
          headers: { Accept: "text/event-stream, application/json" },
        });
        clearTimeout(timer);
        controller.abort();
        return res.ok;
      } catch {
        clearTimeout(timer);
        return false;
      }
    }

    async function checkAll() {
      const results: Record<string, boolean> = {};

      // Code MCP — ping the proxy URL (same-origin)
      if (enabledMcps.code !== false && codeProjectPath?.trim()) {
        results.code = await pingUrl(codeProjectPath);
      }

      // Figma MCP — OAuth token check or ping local URL
      if (enabledMcps.figma !== false) {
        if (figmaOAuth) {
          results.figma = typeof window !== "undefined" && !!localStorage.getItem("figma_mcp_tokens");
        } else if (figmaMcpUrl?.trim()) {
          results.figma = await pingUrl(figmaMcpUrl);
        }
      }

      // GitHub MCP — OAuth token check
      if (enabledMcps.github) {
        results.github = typeof window !== "undefined" && !!localStorage.getItem("github_mcp_tokens");
      }

      // Figma Console — OAuth token check
      if (enabledMcps.figmaConsole) {
        results.figmaConsole = typeof window !== "undefined" && !!localStorage.getItem("southleft_access_token");
      }

      if (!cancelled) setMcpReachable(results);
    }

    checkAll();
    const interval = setInterval(checkAll, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [codeProjectPath, figmaMcpUrl, figmaOAuth, enabledMcps]);

  // ── Target items for Design and Code selectors ──────────────────────
  const designTargets: TargetItem[] = useMemo(() => {
    const items: TargetItem[] = [];

    // Live Figma plugins from presence
    const plugins = clients.filter(c => c.type === "figma-plugin");
    if (plugins.length > 0) {
      plugins.forEach(c => items.push({
        id: `plugin:${c.clientId}`,
        kind: "plugin",
        label: c.shortId,
        subtitle: c.figmaContext?.currentPage?.name ?? undefined,
        status: "active",
        tooltip: "Active",
        description: "Connected via real-time presence. Commands will be executed in this Figma instance.",
        clientId: c.clientId,
      }));
    } else {
      items.push({
        id: "plugin:none",
        kind: "plugin",
        label: "Plugin",
        status: "not-configured",
        tooltip: "Not configured",
        description: "No Figma plugin detected. Open the Guardian plugin in Figma Desktop or Web to connect.",
      });
    }

    // Figma MCP (REST API)
    if (enabledMcps.figma !== false) {
      const configured = !!figmaMcpUrl || figmaOAuth || !!figmaAccessToken;
      const reachable = mcpReachable.figma ?? false;
      const status = !configured ? "not-configured" as const : reachable ? "active" as const : "offline" as const;
      items.push({
        id: "mcp:figma",
        kind: "mcp",
        label: "Figma MCP",
        status,
        tooltip: status === "active" ? "Active" : status === "offline" ? "Offline" : "Not configured",
        description: !configured
          ? "Set a Figma MCP URL or sign in with Figma OAuth in settings."
          : reachable
            ? "Figma REST API connected. Can read and analyze design files."
            : "Figma MCP configured but not reachable. Check if the server is running or re-authenticate.",
      });
    }

    // Figma Console MCP (Southleft)
    if (enabledMcps.figmaConsole) {
      const reachable = mcpReachable.figmaConsole ?? false;
      items.push({
        id: "mcp:figmaConsole",
        kind: "mcp",
        label: "Figma Console",
        status: reachable ? "active" : "not-configured",
        tooltip: reachable ? "Active" : "Not configured",
        description: reachable
          ? "Figma Console connected via OAuth. Provides advanced design introspection."
          : "Sign in with Figma Console in settings to enable.",
      });
    }

    return items;
  }, [clients, enabledMcps, figmaOAuth, figmaAccessToken, figmaMcpUrl, mcpReachable]);

  const codeTargets: TargetItem[] = useMemo(() => {
    const items: TargetItem[] = [];

    // Code Editor MCP (local SSE)
    if (enabledMcps.code !== false) {
      const configured = !!(codeProjectPath?.trim());
      const reachable = mcpReachable.code ?? false;
      const status = !configured ? "not-configured" as const : reachable ? "active" as const : "offline" as const;
      items.push({
        id: "mcp:code",
        kind: "mcp",
        label: "Code Editor",
        status,
        tooltip: status === "active" ? "Active" : status === "offline" ? "Offline" : "Not configured",
        description: !configured
          ? "Set a Code MCP URL in settings to connect your local editor."
          : reachable
            ? "Code MCP connected. Can read and write project files."
            : "Code MCP configured but not reachable. Check if the server is running.",
      });
    }

    // GitHub MCP
    if (enabledMcps.github) {
      const reachable = mcpReachable.github ?? false;
      items.push({
        id: "mcp:github",
        kind: "mcp",
        label: "GitHub MCP",
        status: reachable ? "active" : "not-configured",
        tooltip: reachable ? "Active" : "Not configured",
        description: reachable
          ? "GitHub API connected via OAuth. Can access repositories and issues."
          : "Sign in with GitHub in settings to enable.",
      });
    }

    return items;
  }, [codeProjectPath, githubOAuth, enabledMcps, mcpReachable]);

  const handleModelDropdownClose = useCallback(() => {
    setModelDropdownOpen(false);
    setModelSearch("");
  }, []);

  // Load user's BYOK keys + full model catalog + default model on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/user/api-keys").then((r) => r.ok ? r.json() : { keys: [] }),
      fetch("/api/gateway-models").then((r) => r.ok ? r.json() : { models: [] }).catch(() => ({ models: [] })),
      fetch("/api/user/settings").then((r) => r.ok ? r.json() : { defaultModel: null }).catch(() => ({ defaultModel: null })),
    ]).then(([keysData, gwData, settingsData]: [Record<string, unknown>, Record<string, unknown>, { defaultModel: string | null }]) => {
      const keys: { provider: string; is_default: boolean }[] = (keysData.keys ?? []) as { provider: string; is_default: boolean }[];
      const models: GatewayModel[] = (gwData.models ?? []) as GatewayModel[];
      const userDefaultModel: string | null = settingsData.defaultModel ?? null;
      setByokKeys(keys);
      setGatewayModels(models);

      // Priority: user's saved default model > first model from default key's provider
      if (userDefaultModel && models.length > 0) {
        // Verify the saved model is still accessible with current keys
        const hasGateway = keys.some((k) => k.provider === "gateway");
        const directProviders = new Set(keys.filter((k) => k.provider !== "gateway").map((k) => k.provider));
        const getModelValue = (m: GatewayModel) =>
          hasGateway ? m.id : `${m.owned_by}/${m.id.split("/").pop()}`;
        const isAccessible = keys.length === 0 || models.some((m) => getModelValue(m) === userDefaultModel);
        if (isAccessible) {
          setSelectedModel(userDefaultModel);
          return;
        }
      }

      // Fallback: auto-select first model matching the default key's provider
      const defaultKey = keys.find((k) => k.is_default);
      if (defaultKey && models.length > 0) {
        const firstMatch = defaultKey.provider === "gateway"
          ? models[0]
          : models.find((m) => m.owned_by === defaultKey.provider);
        if (firstMatch) {
          setSelectedModel(
            defaultKey.provider === "gateway"
              ? firstMatch.id
              : `${defaultKey.provider}/${firstMatch.id.split("/").pop()}`
          );
        }
      }
    }).catch(() => {});
  }, []);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  const figmaMcpUrlRef = useRef(figmaMcpUrl);
  figmaMcpUrlRef.current = figmaMcpUrl;
  const figmaAccessTokenRef = useRef(figmaAccessToken);
  figmaAccessTokenRef.current = figmaAccessToken;
  const codeProjectPathRef = useRef(codeProjectPath);
  codeProjectPathRef.current = codeProjectPath;
  const figmaOAuthRef = useRef(figmaOAuth);
  figmaOAuthRef.current = figmaOAuth;
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;
  const selectedNodeRef = useRef(selectedNode);
  selectedNodeRef.current = selectedNode;
  const figmaPluginContextRef = useRef(figmaPluginContext);
  figmaPluginContextRef.current = figmaPluginContext;
  const clientsRef = useRef(clients);
  clientsRef.current = clients;
  const selectedDesignTargetRef = useRef(selectedDesignTarget);
  selectedDesignTargetRef.current = selectedDesignTarget;
  const designTargetsRef = useRef(designTargets);
  designTargetsRef.current = designTargets;
  const isFigmaPluginRef = useRef(isFigmaPlugin);
  isFigmaPluginRef.current = isFigmaPlugin;
  const myClientIdRef = useRef(myClientId);
  myClientIdRef.current = myClientId;
  const tunnelSecretRef = useRef(tunnelSecret);
  tunnelSecretRef.current = tunnelSecret;
  const oauthSessionRef = useRef<string | null>(null);
  const localFigmaMcpUrlRef = useRef(localFigmaMcpUrl);
  localFigmaMcpUrlRef.current = localFigmaMcpUrl;
  const localCodeMcpUrlRef = useRef(localCodeMcpUrl);
  localCodeMcpUrlRef.current = localCodeMcpUrl;
  const enabledMcpsRef = useRef(enabledMcps);
  enabledMcpsRef.current = enabledMcps;
  const sendToPluginRef = useRef(sendToPlugin);
  sendToPluginRef.current = sendToPlugin;
  const executeCodeRef = useRef(executeCode);
  executeCodeRef.current = executeCode;
  const agentRoleRef = useRef(agentRole);
  agentRoleRef.current = agentRole;
  const orchestrationRef = useRef(orchestration);
  orchestrationRef.current = orchestration;
  const collaboratorsRef = useRef(collaborators);
  collaboratorsRef.current = collaborators;
  // Stores the original user request when orchestration starts, so we can dispatch
  // it directly to collaborators instead of relying on AI-generated @mentions.
  const orchestrationTaskRef = useRef<string | null>(null);
  // Snapshot of useChat messages taken just before becomeOrchestrator — used to
  // recover if messages are unexpectedly cleared during the async orchestration flow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const preOrchMessagesRef = useRef<any[] | null>(null);

  // Notify the Figma plugin that the user is authenticated
  useEffect(() => {
    try {
      window.parent.postMessage({ source: "figpal-webapp", type: "AUTH_STATE", authenticated: true }, "*");
    } catch (_) {}
  }, []);

  // Sync figmaContext from hook → local state used by the rest of the component
  useEffect(() => {
    if (figmaContext) {
      setFigmaPluginContext({
        fileKey: figmaContext.fileKey ?? '',
        fileName: figmaContext.fileName,
        fileUrl: figmaContext.fileUrl ?? '',
        currentPage: figmaContext.currentPage,
        pages: figmaContext.pages,
        currentUser: figmaContext.currentUser,
      });
    }
  }, [figmaContext]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      console.log('Webapp received message:', event.data);
      if (event.data && typeof event.data === "object" &&
          (event.data.type === "selection-changed" || event.data.type === "response") &&
          "data" in event.data && event.data.data) {
        const d = event.data.data as { nodes?: unknown[]; image?: string | null; nodeUrl?: string | null };
        const d2 = { nodes: d.nodes ?? [], image: d.image ?? null, nodeUrl: d.nodeUrl ?? null };
        console.log(d2);
        setSelectedNode(d2);
      }
      if (event.data && typeof event.data === "object" && event.data.type === "southleft-mcp-auth") {
        console.log('Received southleft-mcp-auth:', event.data.success);
        if (event.data.success) {
          setSouthleftOAuth(true);
        }
      }

      // Reset conversation before a new analysis
      if (event.data && typeof event.data === "object" && event.data.type === "reset-conversation") {
        setMessages([]);
      }

      // Fake agent message injected from the plugin mini-mode tooltip
      if (event.data && typeof event.data === "object" && event.data.type === "inject-agent-message") {
        const text = (event.data as { type: string; text: string }).text;
        setPendingAgentMessage(text);
      }

      // Auto-trigger analysis sent by the plugin 400ms after inject-agent-message
      if (event.data && typeof event.data === "object" && event.data.type === "trigger-user-analysis") {
        sendMessageEarlyRef.current?.({ text: "Yes analyze my new figma selection" });
      }

      // GitHub OAuth popup fast-path
      if (event.data && typeof event.data === "object" && event.data.type === "github-oauth-complete") {
        if (event.data.success) {
          if (event.data.tokensJson && typeof window !== 'undefined') {
            try { localStorage.setItem('github_mcp_tokens', event.data.tokensJson as string); } catch(_) {}
          }
          setGithubOAuth(true);
        }
        setGithubWaitingForOAuth(false);
      }
      if (event.data && typeof event.data === "object" && event.data.type === "github-oauth-error") {
        console.error("[GitHub OAuth] Error from popup:", event.data.error);
        setGithubWaitingForOAuth(false);
      }

      // Figma official OAuth popup fast-path
      if (event.data && typeof event.data === "object" && event.data.type === "figma-oauth-complete") {
        if (event.data.success) {
          if (event.data.tokensJson && typeof window !== 'undefined') {
            try { localStorage.setItem('figma_mcp_tokens', event.data.tokensJson as string); } catch(_) {}
          }
          setFigmaOAuth(true);
        }
        setFigmaWaitingForOAuth(false);
      }
      if (event.data && typeof event.data === "object" && event.data.type === "figma-oauth-error") {
        console.error("[Figma OAuth] Error from popup:", event.data.error);
        setFigmaWaitingForOAuth(false);
      }

      // Token relay from OAuth popup via postMessage
      if (event.data && typeof event.data === "object" && event.data.type === "southleft-oauth-complete") {
        const accessToken = event.data.accessToken as string | undefined;
        if (accessToken) {
          localStorage.setItem('southleft_access_token', accessToken);
          setSouthleftOAuth(true);
          setWaitingForOAuth(false);
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [tunnelSecret]);

  // Check localStorage for southleft access token to determine auth status
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('southleft_access_token');
      setSouthleftOAuth(!!token);
    }
  }, []);

  // If this page is the popup landing after OAuth, relay token to opener then close
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const isAuthSuccess = params.get('auth') === 'success';
    const source = params.get('source');
    const isPopup = params.get('popup') === 'true';

    if (isAuthSuccess && isPopup && source === 'southleft-mcp') {
      const accessToken = localStorage.getItem('southleft_access_token');
      if (accessToken && window.opener) {
        try {
          window.opener.postMessage({ type: 'southleft-oauth-complete', accessToken }, '*');
        } catch (e) {
          console.warn('[southleft popup] postMessage to opener failed:', e);
        }
      }
      // Give a short delay so the message is dispatched before close
      setTimeout(() => { try { window.close(); } catch (_) {} }, 300);
    }
  }, []);

  // Polling fallback: if postMessage to opener failed, retrieve token from server relay
  useEffect(() => {
    if (!waitingForOAuth) return;
    let interval: NodeJS.Timeout;
    let timeout: NodeJS.Timeout;

    const poll = async () => {
      try {
        const res = await fetch('/api/set-oauth-result', {
          headers: oauthSessionRef.current ? { 'X-Auth-Token': oauthSessionRef.current } : {},
        });
        const data = await res.json();
        if (data?.type === 'southleft-mcp-auth' && data.success && data.access_token) {
          localStorage.setItem('southleft_access_token', data.access_token as string);
          setSouthleftOAuth(true);
          setWaitingForOAuth(false);
        }
      } catch {
        // ignore transient errors
      }
    };

    interval = setInterval(poll, 2000);
    timeout = setTimeout(() => {
      setWaitingForOAuth(false);
      clearInterval(interval);
    }, 60000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [waitingForOAuth]);

  // Polling fallback for GitHub MCP OAuth popup
  useEffect(() => {
    if (!githubWaitingForOAuth) return;
    let interval: NodeJS.Timeout;
    let timeout: NodeJS.Timeout;
    const poll = async () => {
      try {
        const res = await fetch('/api/set-oauth-result', {
          headers: githubOAuthSessionRef.current ? { 'X-Auth-Token': githubOAuthSessionRef.current } : {},
        });
        const data = await res.json();
        if (data?.type === 'github-mcp-auth') {
          if (data.success) {
            const tokensJson = data.tokens?.github_mcp_tokens as string | undefined;
            if (tokensJson) {
              try { localStorage.setItem('github_mcp_tokens', tokensJson); } catch(_) {}
            }
            setGithubOAuth(true);
          }
          setGithubWaitingForOAuth(false);
        }
      } catch { /* ignore */ }
    };
    interval = setInterval(poll, 2000);
    timeout = setTimeout(() => { setGithubWaitingForOAuth(false); clearInterval(interval); }, 60000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [githubWaitingForOAuth]);

  // Polling fallback for Figma official OAuth popup
  useEffect(() => {
    if (!figmaWaitingForOAuth) return;
    let interval: NodeJS.Timeout;
    let timeout: NodeJS.Timeout;
    const poll = async () => {
      try {
        const res = await fetch('/api/set-oauth-result', {
          headers: figmaOAuthSessionRef.current ? { 'X-Auth-Token': figmaOAuthSessionRef.current } : {},
        });
        const data = await res.json();
        if (data?.type === 'figma-mcp-auth') {
          if (data.success) {
            const tokensJson = data.tokens?.figma_mcp_tokens as string | undefined;
            if (tokensJson) {
              try { localStorage.setItem('figma_mcp_tokens', tokensJson); } catch(_) {}
            }
            setFigmaOAuth(true);
          }
          setFigmaWaitingForOAuth(false);
        }
      } catch { /* ignore */ }
    };
    interval = setInterval(poll, 2000);
    timeout = setTimeout(() => { setFigmaWaitingForOAuth(false); clearInterval(interval); }, 60000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [figmaWaitingForOAuth]);

  // Restore GitHub and Figma MCP auth status on mount
  // localStorage takes priority (works in Figma plugin iframe where cookies from OAuth popup are not sent),
  // then fall back to server cookie check.
  useEffect(() => {
    // Figma: localStorage takes priority (works in Figma plugin iframe)
    if (typeof window !== 'undefined' && localStorage.getItem('figma_mcp_tokens')) {
      setFigmaOAuth(true);
    } else {
      fetch("/api/auth/figma-mcp/status", {
        headers: { "X-Auth-Token": tunnelSecret || "" },
      })
        .then((r) => r.json())
        .then((d) => setFigmaOAuth(d.connected))
        .catch(() => {});
    }

    // GitHub: localStorage takes priority (works in Figma plugin iframe)
    if (typeof window !== 'undefined' && localStorage.getItem('github_mcp_tokens')) {
      setGithubOAuth(true);
    } else {
      fetch("/api/auth/github-mcp/status", {
        headers: { "X-Auth-Token": tunnelSecret || "" },
      })
        .then((r) => r.json())
        .then((d) => setGithubOAuth(d.connected))
        .catch(() => {});
    }
  }, [tunnelSecret]);

  useEffect(() => {
    if (selectedNode) {
      setSelectionGlow(true);
      const timer = setTimeout(() => setSelectionGlow(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [selectedNode]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: () => {
          const headers: Record<string, string> = {};
          if (tunnelSecretRef.current) {
            headers['X-Auth-Token'] = tunnelSecretRef.current;
          }
          if (localFigmaMcpUrlRef.current) {
            headers['X-MCP-Figma-URL'] = localFigmaMcpUrlRef.current;
          }
          if (localCodeMcpUrlRef.current) {
            headers['X-MCP-Code-URL'] = localCodeMcpUrlRef.current;
          }
          // Add Bearer token from localStorage if available (Southleft)
          if (typeof window !== 'undefined') {
            const southleftToken = localStorage.getItem('southleft_access_token');
            if (southleftToken) {
              headers['Authorization'] = `Bearer ${southleftToken}`;
            }
            // GitHub MCP tokens — sent as header for Figma plugin context
            // where cookies from the OAuth popup may not be accessible
            const githubTokens = localStorage.getItem('github_mcp_tokens');
            if (githubTokens) {
              headers['X-GitHub-MCP-Tokens'] = githubTokens;
            }
            // Figma MCP tokens — same pattern for Figma plugin context
            const figmaMcpTokens = localStorage.getItem('figma_mcp_tokens');
            if (figmaMcpTokens) {
              headers['X-Figma-MCP-Tokens'] = figmaMcpTokens;
            }
          }
          return headers;
        },
        body: () => {
          // Derive figmaPluginContext and targetClientId from the selected design target
          let pluginContext = figmaPluginContextRef.current;
          const selectedDesign = designTargetsRef.current.find(t => t.id === selectedDesignTargetRef.current);
          // If a plugin is selected (not a server-side MCP), extract its context from presence
          const targetPluginClientId = selectedDesign?.kind === "plugin" ? selectedDesign.clientId : undefined;
          if (!pluginContext && targetPluginClientId) {
            const sel = clientsRef.current.find(c => c.clientId === targetPluginClientId && c.type === "figma-plugin");
            if (sel?.figmaContext) {
              pluginContext = {
                fileKey: sel.fileKey ?? "",
                fileName: sel.figmaContext.fileName ?? "",
                fileUrl: sel.figmaContext.fileUrl ?? (sel.fileKey ? `https://www.figma.com/file/${sel.fileKey}` : ""),
                currentPage: sel.figmaContext.currentPage,
                pages: sel.figmaContext.pages,
                currentUser: sel.figmaContext.currentUser,
              };
            }
          }
          // In collaborator mode, ALWAYS target self — the collaborator works on its own file,
          // regardless of what's selected in the design target dropdown.
          const targetClientId = agentRoleRef.current === 'collaborator'
            ? myClientIdRef.current
            : (targetPluginClientId ?? (isFigmaPluginRef.current ? myClientIdRef.current : undefined));
          // Build list of other connected agents for AI awareness (when idle)
          const otherAgents = agentRoleRef.current === 'idle'
            ? clientsRef.current
                .filter(c => c.clientId !== myClientIdRef.current && c.type !== "overlay")
                .map(c => ({ shortId: c.shortId, label: c.label, type: c.type, fileName: c.figmaContext?.fileName }))
            : undefined;
          // When in collaborator mode, only enable essential MCPs (figma for reading + guardian)
          // to avoid connection failures for Code MCP / GitHub / FigmaConsole which may not be
          // configured on the collaborator's plugin instance.
          const effectiveMcps = agentRoleRef.current === 'collaborator'
            ? { figma: enabledMcpsRef.current.figma, figmaConsole: false, github: false, code: false }
            : enabledMcpsRef.current;
          // Is the plugin context from our own plugin (local) or from a remote target?
          const isLocalPlugin = !!figmaPluginContextRef.current;
          return { figmaMcpUrl: figmaMcpUrlRef.current || (figmaOAuthRef.current ? "https://mcp.figma.com/mcp" : ""), figmaAccessToken: figmaAccessTokenRef.current, codeProjectPath: codeProjectPathRef.current, figmaOAuth: figmaOAuthRef.current, model: selectedModelRef.current, selectedNode: selectedNodeRef.current, tunnelSecret: tunnelSecretRef.current, enabledMcps: effectiveMcps, figmaPluginContext: pluginContext, isLocalPlugin, targetClientId, orchestrationId: orchestrationRef.current?.id, agentRole: agentRoleRef.current, connectedAgents: otherAgents, orchestrationContext: agentRoleRef.current !== 'idle' ? { collaborators: collaboratorsRef.current?.map(c => ({ shortId: c.shortId, label: c.label })), orchestratorShortId: orchestrationRef.current ? myClientIdRef.current : undefined, } : undefined };
        },
      }),
    [],
  );

  const { messages, sendMessage, status, error, setMessages } = useChat({ transport });

  // ── Message persistence ─────────────────────────────────────────────
  const { loaded: messagesLoaded } = useMessagePersistence(
    activeConversationId,
    messages,
    setMessages,
    status,
    myClientId,
    myDisplayShortId,
  );

  // ── Conversation switching handler ──────────────────────────────────
  // When switching away from the orchestration conversation, auto-release the role
  // so the user starts fresh in the new conversation (idle mode, [ORCHESTRATE:] available).
  const handleSwitchConversation = useCallback((id: string) => {
    if (agentRole !== "idle" && orchestration && id !== orchestration.conversationId) {
      completeOrchestration("cancelled");
    }
    switchConversation(id);
  }, [switchConversation, agentRole, orchestration, completeOrchestration]);

  const [errorVisible, setErrorVisible] = useState(false);
  useEffect(() => {
    if (error) setErrorVisible(true);
  }, [error]);

  // Keep a ref to messages to avoid stale closures in effects
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // ── Auto-rename conversation based on first user message ──────────
  const renamedConvIds = useRef(new Set<string>());

  useEffect(() => {
    if (!activeConversationId || !activeConversation) return;
    // Only rename conversations still titled "New conversation"
    if (activeConversation.title !== "New conversation") {
      renamedConvIds.current.add(activeConversationId);
      return;
    }
    if (renamedConvIds.current.has(activeConversationId)) return;

    // Find the first user message
    const firstUserMsg = messages.find((m) => m.role === "user");
    if (!firstUserMsg) return;

    // Wait until the assistant has responded (stream complete)
    const hasAssistantReply = messages.some((m) => m.role === "assistant");
    if (!hasAssistantReply || status !== "ready") return;

    // Mark as renamed to avoid re-triggering
    renamedConvIds.current.add(activeConversationId);

    // Extract title from first user message (first 60 chars, trimmed at word boundary)
    const text = firstUserMsg.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) return;

    const title = text.length <= 60 ? text : text.slice(0, 57).replace(/\s\S*$/, "") + "…";
    updateTitle(activeConversationId, title);
  }, [activeConversationId, activeConversation, messages, status, updateTitle]);

  // Wire the stable ref (declared early) to sendMessage now that it's available
  sendMessageEarlyRef.current = sendMessage;

  // ── Collaborative Agents: handle incoming agent_request (collaborator side) ──
  // When the orchestrator sends us a task, switch to the collaborative conversation
  // and auto-trigger the LLM with the task content.
  onAgentRequest.current = (payload) => {
    // Use refs to avoid stale closure — agentRole/conversations may be outdated at callback time
    if (agentRoleRef.current !== "collaborator") return;
    if (payload.targetClientId && payload.targetClientId !== myClientIdRef.current) return;

    // The collaborative conversation was already created during acceptInvite.
    // Find it by orchestrationId and switch to it.
    const findAndSwitch = (convs: { id: string; orchestration_id: string | null }[]) => {
      const conv = convs.find(c => c.orchestration_id === payload.orchestrationId);
      if (conv) {
        switchConversation(conv.id);
        return true;
      }
      return false;
    };

    if (!findAndSwitch(conversations)) {
      // Refresh conversations list in case it was just created
      loadConversations().then((convs) => {
        if (convs && !findAndSwitch(convs)) {
          // Last resort: retry after state propagation
          setTimeout(() => findAndSwitch(conversations), 500);
        }
      });
    }

    // Auto-send the task as a user message to trigger the LLM
    setTimeout(() => {
      sendMessageEarlyRef.current?.({
        text: `[Orchestrator task] ${payload.content}${payload.expectedResult ? `\n\nExpected result: ${payload.expectedResult}` : ""}`,
      });
    }, 1500);
  };

  // ── Collaborative Agents: dispatch task directly when collaborator accepts ──
  const notifiedCollaborators = useRef(new Set<string>());
  const dispatchedCollaborators = useRef(new Set<string>());
  // Queue for notifications to send to orchestrator chat (avoids concurrent sendMessage crashes)
  const pendingNotifications = useRef<string[]>([]);
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  onCollaboratorReady.current = (senderId, senderShortId) => {
    // Dedup: only notify once per collaborator per orchestration
    if (notifiedCollaborators.current.has(senderId)) return;
    notifiedCollaborators.current.add(senderId);

    // Find the collaborator's info
    const client = clientsRef.current.find(c => c.clientId === senderId);
    const fileName = client?.figmaContext?.fileName || "unknown file";
    const task = orchestrationTaskRef.current || "Collaborative task";

    // Directly dispatch the original task to this collaborator (no AI middleman)
    if (!dispatchedCollaborators.current.has(senderId)) {
      const perAgentTask = `${task}\n\nYour target: "${fileName}". Execute the part of this task that applies to your file.`;
      sendAgentRequest(senderId, perAgentTask, {}, `Complete the task on ${fileName}`);
      dispatchedCollaborators.current.add(senderId);
    }

    // Queue notification — batch multiple acceptances into one message.
    // We inject via setMessages (not sendMessage) to avoid:
    // 1. Triggering a useless AI response to "agents joined"
    // 2. Potential message loss from sendMessage if useChat state was cleared
    pendingNotifications.current.push(`${senderShortId} (${fileName})`);
    if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
    notificationTimerRef.current = setTimeout(() => {
      const agents = pendingNotifications.current.splice(0);
      if (agents.length > 0) {
        const joined = agents.map(a => `#${a.replace(/^#/, "")}`).join(", ");
        const notifText = `[${joined} joined the session and received their tasks. Wait for their reports before taking action.]`;
        // If messages were lost (cleared by something during orchestration flow),
        // restore from the snapshot taken before becomeOrchestrator.
        const currentMsgs = messagesRef.current;
        const base = (currentMsgs.length === 0 && preOrchMessagesRef.current?.length)
          ? preOrchMessagesRef.current
          : currentMsgs;
        // Inject notification as a system-style user message (no API call)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setMessages([...base, {
          id: `orch-notif-${Date.now()}`,
          role: "user",
          parts: [{ type: "text" as const, text: notifText }],
        }] as any);
      }
    }, 2000);
  };

  // ── Collaborative Agents: collaborator auto-reports result back to orchestrator ──
  const lastReportedMsgId = useRef<string | null>(null);
  useEffect(() => {
    if (agentRole !== "collaborator" || status !== "ready") return;
    if (!orchestration) return;

    // Find the last assistant message
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
    if (!lastAssistant || lastReportedMsgId.current === lastAssistant.id) return;

    // Only report if the first user message was an orchestrator task
    const firstUser = messages.find(m => m.role === "user");
    const isTaskResponse = firstUser?.parts?.some(
      (p): p is { type: "text"; text: string } => p.type === "text" && p.text?.startsWith("[Orchestrator task]"),
    );
    if (!isTaskResponse) return;

    lastReportedMsgId.current = lastAssistant.id;

    // Extract the AI's response text, stripping MCP noise
    const responseText = lastAssistant.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map(p => p.text)
      .join("\n")
      .replace(/\[MCP_STATUS:\w+\]/g, "")
      .replace(/\[MCP_ERROR_BLOCK\][\s\S]*?\[\/MCP_ERROR_BLOCK\]/g, "")
      .trim();

    if (!responseText || responseText.length < 5) return;

    // Send agent_response back to the orchestrator
    sendAgentResponse("task", "completed", responseText);
  }, [agentRole, status, orchestration, messages, sendAgentResponse]);

  // ── Collaborative Agents: reset per-orchestration tracking when role goes idle ──
  useEffect(() => {
    if (agentRole === "idle") {
      notifiedCollaborators.current.clear();
      dispatchedCollaborators.current.clear();
      orchestrationTaskRef.current = null;
      preOrchMessagesRef.current = null;
    }
  }, [agentRole]);

  // ── Collaborative Agents: orchestrator displays agent responses in chat ──
  onAgentResponse.current = (payload) => {
    if (agentRoleRef.current !== "orchestrator") return;

    const collab = collaborators.find(c => c.clientId === payload.senderId);
    const label = collab?.shortId || payload.senderShortId;
    const reportText = `[Agent report from ${label}] ${payload.summary || "Task completed"}`;

    // If messages were lost during orchestration, restore from snapshot before sending.
    // This ensures the AI sees the full conversation context (original request + notification + reports).
    if (messagesRef.current.length === 0 && preOrchMessagesRef.current?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setMessages(preOrchMessagesRef.current as any);
      // Wait for state to propagate before triggering AI
      setTimeout(() => {
        sendMessageEarlyRef.current?.({ text: reportText });
      }, 200);
    } else {
      sendMessageEarlyRef.current?.({ text: reportText });
    }
  };

  // Inject fake agent message from plugin mini-mode tooltip
  // (user message sending is triggered separately via trigger-user-analysis)
  useEffect(() => {
    if (pendingAgentMessage !== null) {
      const text = pendingAgentMessage;
      setPendingAgentMessage(null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setMessages([...messagesRef.current, {
        id: `agent-prompt-${Date.now()}`,
        role: "assistant",
        parts: [{ type: "text", text: `${text} [ANALYZE_BTN]` }],
      }] as any);
    }
  }, [pendingAgentMessage]);

  const isLoading = status === "submitted" || status === "streaming";

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const threshold = 40;
    shouldAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };





  useEffect(() => {
    if (shouldAutoScroll.current) {
      const el = scrollContainerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [messages]);

  useEffect(() => {
    if (!isLoading) {
      inputRef.current?.focus();
    }
  }, [isLoading]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    shouldAutoScroll.current = true;
    sendMessage({ text: input });
    setInput("");
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  };

  const figmaConnected = figmaOAuth || figmaAccessToken.trim().length > 0 || (figmaMcpUrl?.trim().length ?? 0) > 0;
  const codeConnected = (codeProjectPath?.trim().length ?? 0) > 0;

  // Function to detect the MCP connection mode
  const getMcpConnectionMode = (url: string): { mode: 'direct' | 'proxy-local' | 'proxy-online'; label: string; color: string } => {
    if (!url) return { mode: 'direct', label: 'Not configured', color: 'text-white/40' };

    if (url.includes('trycloudflare.com') || url.includes('ngrok') || (url.startsWith('https://') && !url.includes('localhost'))) {
      return { mode: 'proxy-online', label: '🔵 Proxy Online', color: 'text-blue-400' };
    }

    if (url.includes('/proxy-local/') || url.includes('localhost:3000/proxy-local')) {
      return { mode: 'proxy-local', label: '🟢 Proxy Local', color: 'text-amber-400' };
    }

    return { mode: 'direct', label: '⚪ Direct', color: 'text-white/60' };
  };

  const figmaMode = getMcpConnectionMode(figmaMcpUrl || (figmaOAuth ? "https://mcp.figma.com/mcp" : ""));
  const codeMode = getMcpConnectionMode(codeProjectPath || "");

  return (
    <div className="relative flex h-screen text-white overflow-hidden">
      {settingsOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSettingsOpen(false)}
        />
      )}
      <div
        className={`${settingsOpen ? "w-full sm:w-80 translate-x-0" : "w-0 -translate-x-full md:translate-x-0"} fixed top-0 left-0 md:relative md:top-auto md:left-auto z-50 md:z-auto h-full transition-all duration-200 overflow-hidden glass-sidebar`}
      >
        <div className="p-4 w-full sm:w-80 h-full overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">
              MCP Connections
            </h2>
            <button
              onClick={() => setSettingsOpen(false)}
              className="p-1 rounded-md hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors"
              title="Close"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>

          {/* MCP Toggles */}
          <div className="mb-4 p-3 bg-white/5 rounded-md border border-white/10">
            <p className="text-xs text-white/50 mb-2 font-medium">Enable MCPs</p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabledMcps.figma}
                  onChange={() => toggleMcp('figma')}
                  className="w-4 h-4 rounded border-white/20 bg-white/5 text-violet-500 focus:ring-violet-500/50"
                />
                <span className="text-xs text-white/70">Figma MCP</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabledMcps.figmaConsole}
                  onChange={() => toggleMcp('figmaConsole')}
                  className="w-4 h-4 rounded border-white/20 bg-white/5 text-violet-500 focus:ring-violet-500/50"
                />
                <span className="text-xs text-white/70">Figma Console (Southleft)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabledMcps.github}
                  onChange={() => toggleMcp('github')}
                  className="w-4 h-4 rounded border-white/20 bg-white/5 text-violet-500 focus:ring-violet-500/50"
                />
                <span className="text-xs text-white/70">GitHub MCP</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabledMcps.code}
                  onChange={() => toggleMcp('code')}
                  className="w-4 h-4 rounded border-white/20 bg-white/5 text-violet-500 focus:ring-violet-500/50"
                />
                <span className="text-xs text-white/70">Code MCP</span>
              </label>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-white/50">
                  Figma MCP URL
                </label>
                <button
                  onClick={() => setProxyModalOpen(true)}
                  title="Configure a local proxy"
                  className="text-[10px] px-2 py-0.5 bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/80 rounded transition-colors cursor-pointer"
                >
                  Configure proxy
                </button>
              </div>
              <input
                type="url"
                value={figmaMcpUrl}
                onChange={(e) => setFigmaMcpUrl(e.target.value)}
                placeholder="http://127.0.0.1:3845/mcp"
                className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30 disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <div className="flex items-center gap-1.5 mt-1.5">
                <div
                  className={`w-1.5 h-1.5 rounded-full ${figmaConnected ? "bg-emerald-400" : "bg-white/20"}`}
                />
                <span className={`text-xs ${figmaMode.color}`}>
                  {figmaConnected ? figmaMode.label : "Not configured"}
                </span>
              </div>
            </div>

            <div>
              <label className="block text-xs text-white/50 mb-1">
                Figma Authentication
              </label>
              {figmaOAuth ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1 flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <span className="text-xs text-emerald-300">Connected via OAuth</span>
                  </div>
                  <button
                    onClick={() => {
                      fetch("/api/auth/figma-mcp/status", {
                        method: "DELETE",
                        headers: {
                          "X-Auth-Token": tunnelSecret || "",
                        },
                      }).then(() => {
                        localStorage.removeItem('figma_mcp_tokens');
                        setFigmaOAuth(false);
                      });
                    }}
                    className="px-2 py-2 text-xs text-red-400 hover:bg-red-500/10 rounded-md transition-colors cursor-pointer"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <button
                  onClick={async () => {
                    // Attempt Dynamic Client Registration first (required for mcp:connect scope)
                    try {
                      const res = await fetch("/api/auth/figma-mcp/register", { method: "POST" });
                      if (res.ok) {
                        console.log("[Figma] DCR successful, proceeding with MCP OAuth");
                      } else {
                        console.warn("[Figma] DCR failed (status", res.status, "), falling back to standard OAuth");
                      }
                    } catch (e) {
                      console.warn("[Figma] DCR request failed, falling back to standard OAuth:", e);
                    }
                    // Open popup (works inside Figma plugin iframe)
                    const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
                    figmaOAuthSessionRef.current = session;
                    window.open(`/api/auth/figma-mcp?session=${session}`, 'figma-oauth', 'width=600,height=700,scrollbars=yes,resizable=yes');
                    setFigmaWaitingForOAuth(true);
                  }}
                  className="block w-full text-center bg-[#a259ff]/20 border border-[#a259ff]/30 hover:bg-[#a259ff]/30 rounded-md px-3 py-2 text-sm text-[#a259ff] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={figmaWaitingForOAuth}
                >
                  {figmaWaitingForOAuth ? "⏳ Waiting for Figma…" : "Sign in with Figma"}
                </button>
              )}
            </div>

{/* Southleft Figma Console */}
<div className="mt-4 pt-4 border-t border-white/5">
  <label className="block text-xs text-white/50 mb-2 font-medium">Figma Console (Southleft)</label>
  {southleftOAuth ? (
    <div className="flex items-center gap-2">
      <div className="flex-1 flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span className="text-xs text-emerald-300">Connected via OAuth</span>
      </div>
      <button
        onClick={async () => {
          await fetch('/api/auth/southleft-mcp/disconnect', { method: 'POST' });
          localStorage.removeItem('southleft_access_token');
          setSouthleftOAuth(false);
        }}
        className="px-2 py-2 text-xs text-red-400 hover:bg-red-500/10 rounded-md transition-colors cursor-pointer"
      >
        Disconnect
      </button>
    </div>
  ) : (
    <button
      onClick={() => {
        const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
        oauthSessionRef.current = session;
        window.open(`/api/auth/southleft-mcp?session=${session}`, 'southleft-oauth', 'width=600,height=700,scrollbars=yes,resizable=yes');
        setWaitingForOAuth(true);
      }}
      className="w-full text-center bg-gradient-to-r from-purple-600/20 to-pink-600/20 border border-purple-500/30 hover:from-purple-600/30 hover:to-pink-600/30 rounded-md px-3 py-2.5 text-sm text-purple-300 font-medium transition-all hover:shadow-lg"
    >
      🎛️ Sign in with Figma Console
    </button>
  )}
  <span className="text-xs text-white/30 mt-1 block">Alternative MCP server</span>
</div>

           {/*  <div>
              <label className="block text-xs text-white/50 mb-1">
                Figma Access Token (legacy)
              </label>
              <input
                type="password"
                value={figmaAccessToken}
                onChange={(e) => setFigmaAccessToken(e.target.value)}
                placeholder="figd_..."
                className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
              />
              <span className="text-xs text-white/30 mt-1 block">
                Fallback if OAuth not used.
              </span>
            </div> */}

            <div>
              <label className="block text-xs text-white/50 mb-1">
                Code Editor MCP Url
              </label>
              <input
                type="text"
                value={codeProjectPath}
                onChange={(e) => setCodeProjectPath(e.target.value)}
                placeholder="http://127.0.0.1:3846/sse"
                className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
              />
              <div className="flex items-center gap-1.5 mt-1.5">
                <div
                  className={`w-1.5 h-1.5 rounded-full ${codeConnected ? "bg-emerald-400" : "bg-white/20"}`}
                />
                <span className={`text-xs ${codeMode.color}`}>
                  {codeConnected ? codeMode.label : "Not configured"}
                </span>
              </div>
            </div>

{/* GitHub MCP */}
<div className="mt-4 pt-4 border-t border-white/5">
  <label className="block text-xs text-white/50 mb-2 font-medium">GitHub MCP</label>
  {githubOAuth ? (
    <div className="flex items-center gap-2">
      <div className="flex-1 flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span className="text-xs text-emerald-300">Connected via OAuth</span>
      </div>
      <button
        onClick={() => {
          fetch("/api/auth/github-mcp/status", {
            method: "DELETE",
            headers: {
              "X-Auth-Token": tunnelSecret || "",
            },
          }).then(() => {
            localStorage.removeItem('github_mcp_tokens');
            setGithubOAuth(false);
          });
        }}
        className="px-2 py-2 text-xs text-red-400 hover:bg-red-500/10 rounded-md transition-colors cursor-pointer"
      >
        Disconnect
      </button>
    </div>
  ) : (
    <button
      onClick={() => {
        // Open popup (works inside Figma plugin iframe)
        const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
        githubOAuthSessionRef.current = session;
        window.open(`/api/auth/github-mcp?session=${session}`, 'github-oauth', 'width=600,height=700,scrollbars=yes,resizable=yes');
        setGithubWaitingForOAuth(true);
      }}
      className="w-full text-center bg-gradient-to-r from-gray-600/20 to-black/20 border border-gray-500/30 hover:from-gray-600/30 hover:to-black/30 rounded-md px-3 py-2.5 text-sm text-gray-300 font-medium transition-all hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
      disabled={githubWaitingForOAuth}
    >
      {githubWaitingForOAuth ? "⏳ Waiting for GitHub…" : "🌐 Sign in with GitHub"}
    </button>
  )}
  <span className="text-xs text-white/30 mt-1 block">GitHub repos MCP (online)</span>
</div>

          </div>

          <div className="mt-6 p-3 bg-white/5 rounded-md">
            <p className="text-xs text-white/40 leading-relaxed">
              Set your online URLs for Figma MCCP and Code MCP,
              or configure your local proxy.
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0 relative">
        <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
          <div className="wave-bg-layer wave-bg-1" />
          <div className="wave-bg-layer wave-bg-2" />
          <div className="wave-bg-layer wave-bg-3" />
          <div className="wave-bg-noise" />
          <div className="aurora aurora-1" />
          <div className="aurora aurora-2" />
          <div className="aurora aurora-3" />
          <div className="aurora aurora-4" />
          <div className="aurora aurora-5" />
        </div>
        <header className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-3 sm:px-4 py-3 border-b border-white/30" style={{ background: "rgba(10,10,10,0.3)", backdropFilter: "blur(6px) saturate(1.3)", WebkitBackdropFilter: "blur(6px) saturate(1.3)", boxShadow: "0 4px 24px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.06) inset" }}>
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              onClick={() => setSettingsOpen(!settingsOpen)}
              className="p-2 rounded-md hover:bg-white/5 transition-colors shrink-0 cursor-pointer"
              title="Toggle settings"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold truncate">Guardian</h1>
              <p className="text-xs text-white/65 hidden sm:block">
                [Design ↔ Code] Design System Guardian
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {messages.length > 0 && (
              <button
                onClick={() => { setMessages([]); setErrorVisible(false); }}
                title="Clear conversation"
                className="p-1.5 rounded-md text-white/40 hover:text-white/70 hover:bg-white/10 transition-colors cursor-pointer mr-1"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>
            )}
            <ConversationSwitcher
              conversations={conversations}
              activeId={activeConversationId}
              onSwitch={handleSwitchConversation}
              onCreate={() => createConversation()}
              onDelete={deleteConversation}
            />
            <EditableClientId
              shortId={myDisplayShortId}
              onRenamed={async (newShortId) => {
                const ok = await renameClient(newShortId);
                if (ok) setRegistryShortId(newShortId);
                return ok;
              }}
            />
            <div className="w-px h-4 bg-white/10 mx-1 hidden sm:block" />
            <UserMenu />
          </div>
        </header>

        <OrchestrationStatusBar
          role={agentRole}
          orchestratorShortId={orchestration ? collaborators.find(c => c.status === 'active')?.shortId : undefined}
          collaborators={agentRole === 'orchestrator' ? collaborators : undefined}
          onCancel={agentRole === 'orchestrator' ? () => completeOrchestration('cancelled') : undefined}
        />

        <div ref={scrollContainerRef} onScroll={handleScroll} className="relative flex-1 overflow-y-auto px-3 sm:px-4 pt-16 pb-40">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="text-4xl mb-4">🛡️</div>
              <h2 className="text-lg font-semibold mb-2">
                Welcome to Guardian
              </h2>
              <p className="text-sm text-white/70 max-w-md mb-6">
                I can compare your Figma design system components with their
                code implementation to detect property and variant drift.
              </p>

              {/* Free tier onboarding notice */}
              {byokKeys.length === 0 && (
                <div className="mb-6 w-full max-w-sm rounded-xl bg-white/[0.07] border border-white/[0.15] p-4 text-left">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0 w-7 h-7 rounded-full bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-sm">
                      ✨
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white/90 mb-1">You&apos;re on the free tier</p>
                      <p className="text-xs text-white/60 leading-relaxed mb-3">
                        You get 500k tokens per day on us (rolling 24h window). Each message uses the platform&apos;s AI model.
                      </p>
                      <div className="space-y-2">
                        <p className="text-[11px] text-white/65 font-medium uppercase tracking-wider">Want unlimited access?</p>
                        <div className="space-y-1.5 text-xs text-white/55">
                          <div className="flex items-start gap-2">
                            <span className="shrink-0 mt-0.5">1.</span>
                            <span>
                              Create a free{" "}
                              <a href="https://vercel.com/ai-gateway" target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-300 underline underline-offset-2">
                                Vercel AI Gateway
                              </a>{" "}
                              account — one key to access 100+ AI models
                            </span>
                          </div>
                          <div className="flex items-start gap-2">
                            <span className="shrink-0 mt-0.5">2.</span>
                            <span>Or add your own OpenAI, Anthropic, or Google API key</span>
                          </div>
                        </div>
                        <Link
                          href="/account"
                          className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-lg bg-violet-600/20 border border-violet-500/30 text-xs text-violet-300 hover:bg-violet-600/30 transition-colors"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                          Add an API key
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2 text-sm text-white/60">
                <p>Try asking:</p>
                <button
                  onClick={() => sendMessage({ text: "Check the Button component" })}
                  className="block mx-auto px-3 py-1.5 rounded-md bg-white/8 border border-white/10 hover:bg-white/15 transition-colors cursor-pointer text-white/75"
                >
                  &quot;Check the Button component&quot;
                </button>
                <button
                  onClick={() => sendMessage({ text: "List all components available in Figma" })}
                  className="block mx-auto px-3 py-1.5 rounded-md bg-white/8 border border-white/10 hover:bg-white/15 transition-colors cursor-pointer text-white/75"
                >
                  &quot;List all components available in Figma&quot;
                </button>
              </div>
            </div>
          )}

          {messages.filter((m, idx, arr) => {
            // Deduplicate by ID (keep last occurrence — most complete from streaming)
            if (arr.findLastIndex(x => x.id === m.id) !== idx) return false;
            // Skip empty assistant messages (only MCP_STATUS markers, no real content)
            if (m.role === "assistant") {
              const stripped = m.parts
                ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
                .map(p => p.text)
                .join("")
                .replace(/\[MCP_STATUS:\w+\]/g, "")
                .trim();
              if (!stripped) return false;
            }
            return true;
          }).map((m, mi) => {
            // Detect inter-agent messages (injected by orchestration hooks)
            const msgText = m.parts?.find((p): p is { type: "text"; text: string } => p.type === "text")?.text ?? "";
            const agentJoinMatch = msgText.match(/^Agent (#[\w-]+) \((.+?)\) has joined/);
            const agentReportMatch = msgText.match(/^\[Agent report from (#[\w-]+)\] ([\s\S]*)/);

            if (m.role === "user" && (agentJoinMatch || agentReportMatch)) {
              if (agentJoinMatch) {
                return (
                  <div key={m.id} className="flex justify-center my-2">
                    <div className="px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/15 text-[11px] text-emerald-400/70">
                      <span className="font-medium">{agentJoinMatch[1]}</span> ({agentJoinMatch[2]}) joined the session
                    </div>
                  </div>
                );
              }
              if (agentReportMatch) {
                return (
                  <div key={m.id} className="mb-3">
                    <AgentMessageBubble
                      senderShortId={agentReportMatch[1]}
                      content={agentReportMatch[2]}
                      isOrchestrator={false}
                    />
                  </div>
                );
              }
            }

            return (
            <div
              key={m.id}
              className={`group mb-4 ${m.role === "user" ? "flex justify-end" : ""}`}
            >
              <div className="max-w-full sm:max-w-[80%] inline-block">
              <div
                className={`rounded-lg px-3 sm:px-4 py-2.5 sm:py-3 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "glass-msg-user"
                    : "glass-msg-ai"
                }`}
              >
                {m.parts?.map((part, i) => {
                  if (part.type === "text") {
                    const isLastMsg = m === messages[messages.length - 1];
                    const cleanText = part.text.replace("[CONTINUATION_AVAILABLE]", "");
                    const structuredSegments = parseStructuredContent(cleanText, isLoading && isLastMsg);

                    return (
                      <div key={i}>
                        {structuredSegments.map((structSeg, sj) => {
                          if (structSeg.kind === "thinking") {
                            return <ThinkingBlock key={sj} text={structSeg.text} isLast={isLastMsg} isStreaming={isLoading} />;
                          }
                          if (structSeg.kind === "details") {
                            return <DetailsBlock key={sj} text={structSeg.text} isStreaming={structSeg.streaming} />;
                          }
                          if (structSeg.kind === "qcm") {
                            return <QCMBlock key={sj} choices={structSeg.choices} onSelect={(choice) => { shouldAutoScroll.current = true; sendMessage({ text: choice }); }} disabled={isLoading} />;
                          }
                          if (structSeg.kind === "mcp-error") {
                            return (
                              <MCPErrorBlock
                                key={sj}
                                errorText={structSeg.errorText}
                                onAskHelp={() => {
                                  shouldAutoScroll.current = true;
                                  sendMessage({
                                    text: `I'm having trouble connecting to the MCP servers. Can you help me troubleshoot this error?\n\nError details:\n${structSeg.errorText}`,
                                  });
                                }}
                              />
                            );
                          }
                          if (structSeg.kind === "mcp-status") {
                            return <MCPStatusBlock key={sj} status={structSeg.status} />;
                          }
                          if (structSeg.kind === "analyze-btn") {
                            return (
                              <button
                                key={sj}
                                onClick={() => { shouldAutoScroll.current = true; sendMessage({ text: "Yes analyze my new figma selection" }); }}
                                disabled={isLoading}
                                title="Analyze with AI"
                                className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-blue-500 hover:bg-blue-400 text-white transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ml-1 mt-1 hover:scale-110 hover:shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M12 2.5c0 0 .9 4 2.8 5.5C16.7 9.5 21 9.5 21 9.5s-4.3.1-6.2 1.6C12.9 12.5 12 16.5 12 16.5s-.9-4-2.8-5.5C7.3 9.6 3 9.5 3 9.5s4.3 0 6.2-1.5C11.1 6.5 12 2.5 12 2.5z"/>
                                  <path d="M19.5 15c0 0 .5 2 1.5 2.7 1 .7 2.5.8 2.5.8s-1.5 0-2.5.8c-1 .7-1.5 2.7-1.5 2.7s-.5-2-1.5-2.7c-1-.7-2.5-.8-2.5-.8s1.5-.1 2.5-.8c1-.7 1.5-2.7 1.5-2.7z"/>
                                </svg>
                              </button>
                            );
                          }
                          if (structSeg.kind === "orchestrate-btn") {
                            return (
                              <button
                                key={sj}
                                onClick={async () => {
                                  if (agentRole !== 'idle') return;
                                  const convId = activeConversationId ?? await ensureConversation();
                                  if (!convId) return;
                                  // Extract task BEFORE async becomeOrchestrator — messages may
                                  // be affected by React re-renders during the await.
                                  const lastUserText = messagesRef.current.filter(m => m.role === "user").map(m => m.parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map(p => p.text).join(" ")).pop() || "Collaborative task";
                                  orchestrationTaskRef.current = lastUserText;
                                  // Also snapshot messages so we can restore if they get lost
                                  preOrchMessagesRef.current = [...messagesRef.current];
                                  const orch = await becomeOrchestrator(convId);
                                  if (!orch) return;
                                  // Invite all suggested agents
                                  for (const agentShortId of structSeg.agents) {
                                    const target = clients.find(c => c.shortId === agentShortId && c.clientId !== myClientId);
                                    if (target) {
                                      inviteCollaborator(target.clientId, lastUserText, {}, `Complete the task on ${target.label}`, target.shortId, target.label);
                                    }
                                  }
                                }}
                                disabled={isLoading || agentRole !== 'idle'}
                                className="my-3 flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-all cursor-pointer bg-amber-500/10 border-amber-500/25 text-amber-300 hover:bg-amber-500/20 hover:border-amber-500/40 disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                                  <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M3 4l17 17" />
                                </svg>
                                Start Collaborative Mode
                                <span className="text-xs text-amber-400/50 ml-1">({structSeg.agents.join(", ")})</span>
                              </button>
                            );
                          }

                          // content kind
                          const imageSegments = parseTextWithImages(structSeg.text, isLoading && isLastMsg);
                          return (
                            <div key={sj} className="markdown-body overflow-x-auto">
                              {imageSegments.map((seg, j) =>
                                seg.type === "image" ? (
                                  !seg.complete ? (
                                    <div key={j} className="my-3 flex flex-col items-center justify-center w-full max-w-64 h-48 bg-white/5 border border-white/10 rounded-lg">
                                      <svg className="animate-spin h-8 w-8 text-white/30 mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                      </svg>
                                      <span className="text-xs text-white/30">Loading image…</span>
                                    </div>
                                  ) : (
                                    <img
                                      key={j}
                                      src={seg.src}
                                      alt="Generated image"
                                      className="my-3 max-w-full rounded-lg border border-white/10"
                                    />
                                  )
                                ) : (
                                  <ReactMarkdown key={j} remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                    {seg.content}
                                  </ReactMarkdown>
                                )
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  }
                  // Typed tool calls from the Responses API (e.g.: tool-web_search)
                  if (part.type?.startsWith("tool-")) {
                    const toolName = part.type.replace("tool-", "");
                    const p = part as { type: string; toolCallId: string; state: string; input?: Record<string, unknown>; output?: unknown; errorText?: string; providerExecuted?: boolean };

                    // If the provider executed the tool but we haven't received output-available,
                    // we consider it done when we receive text after
                    const hasTextAfter = m.parts?.slice(i + 1).some((nextPart: { type?: string }) => nextPart.type === "text");
                    const isProviderExecuted = (p as unknown as { providerExecuted?: boolean }).providerExecuted === true;

                    // If providerExecuted=true, the tool is done (executed server-side by xAI)
                    // We don't wait for output-available which never arrives for native xAI tools
                    if (isProviderExecuted || p.state === "output-available") {
                      return (
                        <ToolCallBlock
                          key={i}
                          toolName={toolName}
                          input={p.input}
                          output={p.output || { content: [{ type: "text", text: "Result integrated in the response" }] }}
                          isError={false}
                        />
                      );
                    }

                    switch (p.state) {
                      case "input-streaming":
                      case "input-available":
                        return <ToolCallProgress key={i} toolName={toolName} />;
                      case "output-available":
                        return (
                          <ToolCallBlock
                            key={i}
                            toolName={toolName}
                            input={p.input}
                            output={p.output}
                            isError={false}
                          />
                        );
                      case "output-error":
                        return (
                          <ToolCallBlock
                            key={i}
                            toolName={toolName}
                            input={p.input}
                            output={{ isError: true, content: [{ type: "text", text: p.errorText || "Unknown error" }] }}
                            isError={true}
                          />
                        );
                      default:
                        return <ToolCallProgress key={i} toolName={toolName} />;
                    }
                  }
                  if (part.type === "dynamic-tool") {
                    const p = part as { type: string; toolName: string; state: string; input?: Record<string, unknown>; output?: { content?: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean }; errorText?: string; providerExecuted?: boolean };

                    // If the provider executed the tool but we haven't received output-available,
                    // we consider it done when we receive text after
                    const hasTextAfter = m.parts?.slice(i + 1).some((nextPart: { type?: string }) => nextPart.type === "text");
                    const isProviderExecuted = p.providerExecuted === true;

                    // If providerExecuted=true, the tool is done (executed server-side by xAI)
                    // We don't wait for output-available which never arrives for native xAI tools
                    if (isProviderExecuted || p.state === "output-available") {
                      return (
                        <ToolCallBlock
                          key={i}
                          toolName={p.toolName}
                          input={p.input}
                          output={p.output || { content: [{ type: "text", text: "Result integrated in the response" }] }}
                          isError={p.output?.isError}
                        />
                      );
                    }

                    // Handle all possible tool call states
                    switch (p.state) {
                      case "input-streaming":
                      case "input-available":
                        // Tool call in progress
                        return <ToolCallProgress key={i} toolName={p.toolName} />;
                      case "output-available":
                        return (
                          <ToolCallBlock
                            key={i}
                            toolName={p.toolName}
                            input={p.input}
                            output={p.output}
                            isError={p.output?.isError}
                          />
                        );
                      case "output-error":
                        return (
                          <ToolCallBlock
                            key={i}
                            toolName={p.toolName}
                            input={p.input}
                            output={{ isError: true, content: [{ type: "text", text: p.errorText || "Unknown error" }] }}
                            isError={true}
                          />
                        );
                      default:
                        return <ToolCallProgress key={i} toolName={p.toolName} />;
                    }
                  }
                  return null;
                })}
              </div>
              {m.role === "assistant" && (
                <div className="flex mt-1">
                  <button
                    onClick={() => {
                      const text = m.parts
                        ?.filter((p: { type: string; text?: string }) => p.type === "text" && p.text)
                        .map((p: { type: string; text?: string }) => p.text)
                        .join("\n")
                        .replace(/\[MCP_STATUS:\w+\]/g, "")
                        .replace(/\[MCP_ERROR_BLOCK\][\s\S]*?\[\/MCP_ERROR_BLOCK\]/g, "")
                        .replace(/\[ORCHESTRATE:[^\]]+\]/g, "")
                        .replace(/\[CONTINUATION_AVAILABLE\]/g, "")
                        .replace(/\[ANALYZE_BTN\]/g, "")
                        .trim() || "";
                      copyToClipboard(text);
                    }}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-white/15 hover:text-white/50 hover:bg-white/5 transition-colors cursor-pointer"
                    title="Copy message"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                  </button>
                </div>
              )}
              {m === messages[messages.length - 1] && m.role === "assistant" && !isLoading && m.parts?.some(part => part.type === "text" && part.text.includes("[CONTINUATION_AVAILABLE]")) && (
                <button
                  onClick={() => {
                    shouldAutoScroll.current = true;
                    sendMessage({ text: "Continue your last truncated message" });
                  }}
                  className="mt-2 px-3 py-1.5 text-xs rounded-md bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 hover:text-blue-200 transition-colors cursor-pointer"
                >
                  Continue the response
                </button>
              )}
              </div>
            </div>
          );
          })}

          {isLoading && <ThinkingIndicator />}

          {/* Copy debug context button — always visible after all messages */}
          {messages.length > 0 && !isLoading && (
            <CopyDebugButton
              messages={messages}
              clients={clients}
              myClientId={myClientId}
              myShortId={myDisplayShortId}
              agentRole={agentRole}
              orchestration={orchestration}
              collaborators={collaborators}
              activeConversationId={activeConversationId}
              conversations={conversations}
            />
          )}

          {selectedNode && (
            <div className={`mb-4 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-xs text-purple-300/80 italic${selectionGlow ? " teleport-in" : ""}`}>
              <span className="shrink-0 mt-0.5">👁️</span>
              <div>
                <span>Selection changed in Figma — </span>
                <span className="text-purple-200/90 font-medium not-italic break-all">{selectedNode.nodeUrl}</span>
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button"
                    disabled={isLoading}
                    onClick={() => { shouldAutoScroll.current = true; sendMessage({ text: `Analyse this Figma selection: ${selectedNode}` }); }}
                    className="px-2.5 py-1 rounded bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 not-italic transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Analyze this selection
                  </button>
                </div>
              </div>
            </div>
          )}

          {error && errorVisible && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400 break-words">
              {error?.message?.includes("429") ? (
                <>Daily free tier limit reached (500k tokens). <a href="/account" className="underline hover:text-red-300">Add your own API key</a> for unlimited access.</>
              ) : (
                <>Error: {error?.message ?? "Unknown error"}</>
              )}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="absolute bottom-0 left-0 right-0 z-20 px-3 sm:px-4 pt-6 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pointer-events-none">
          <div className="pointer-events-auto">
          <form
            onSubmit={onSubmit}
            className="relative mx-auto max-w-3xl rounded-2xl border border-white/30 overflow-visible"
            style={{ background: "rgba(10,10,10,0.25)", backdropFilter: "blur(6px) saturate(1.3)", WebkitBackdropFilter: "blur(6px) saturate(1.3)", boxShadow: "0 8px 40px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4), 0 1px 0 rgba(255,255,255,0.05) inset" }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                const maxH = window.innerHeight * 0.3;
                e.target.style.height = Math.min(e.target.scrollHeight, maxH) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e);
                }
              }}
              placeholder="Ask Guardian to check a component..."
              className={`w-full bg-transparent px-4 pt-3 pb-12 text-sm text-white placeholder:text-white/45 focus:outline-none resize-none overflow-y-auto ${isLoading ? "opacity-50" : ""}`}
              readOnly={isLoading}
              rows={3}
            />
            {/* Bottom bar inside the form */}
            <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between gap-2 px-3 py-2">
              {/* Left: target selectors */}
              <div className="flex items-center gap-2">
                <TargetSelector
                  items={designTargets}
                  label="Design"
                  tooltip="Select which design tool receives commands"
                  emptyDescription="All design integrations are disabled. Enable Figma MCP, Plugin, or Console in settings."
                  selected={selectedDesignTarget}
                  onSelect={setSelectedDesignTarget}
                />
                <TargetSelector
                  items={codeTargets}
                  label="Code"
                  tooltip="Select which code tool to use"
                  emptyDescription="All code integrations are disabled. Enable Code Editor or GitHub MCP in settings."
                  selected={selectedCodeTarget}
                  onSelect={setSelectedCodeTarget}
                />
              </div>
              {/* Right: model picker + send */}
              <div className="flex items-center gap-2">
              {byokKeys.length === 0 ? (
                /* Free tier */
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white/55">
                    Free tier · Grok
                  </span>
                  <Link
                    href="/account"
                    className="text-xs text-violet-400 hover:text-violet-300 transition-colors underline underline-offset-2"
                  >
                    Add API key
                  </Link>
                </div>
              ) : (
                /* BYOK — model picker */
                <div className="relative">
                  {(() => {
                    const hasGateway = byokKeys.some((k) => k.provider === "gateway");
                    const directProviders = new Set(byokKeys.filter((k) => k.provider !== "gateway").map((k) => k.provider));
                    const visibleModels = hasGateway
                      ? gatewayModels
                      : gatewayModels.filter((m) => directProviders.has(m.owned_by));
                    const getModelValue = (m: GatewayModel) =>
                      hasGateway ? m.id : `${m.owned_by}/${m.id.split("/").pop()}`;

                    const selectedGw = visibleModels.find((m) => getModelValue(m) === selectedModel);
                    const selectedLabel = selectedGw
                      ? `${selectedGw.name}${selectedGw.tags?.includes("reasoning") ? " ✦" : ""}`
                      : selectedModel;

                    const grouped = visibleModels.reduce<Record<string, GatewayModel[]>>((acc, m) => {
                      (acc[m.owned_by] ??= []).push(m);
                      return acc;
                    }, {});

                    const query = modelSearch.toLowerCase();
                    const filteredGrouped = Object.entries(grouped).reduce<Record<string, GatewayModel[]>>((acc, [provider, models]) => {
                      const filtered = models.filter((m) =>
                        m.name.toLowerCase().includes(query) || provider.toLowerCase().includes(query)
                      );
                      if (filtered.length > 0) acc[provider] = filtered;
                      return acc;
                    }, {});

                    return (
                      <>
                        <button
                          ref={modelBtnRef}
                          type="button"
                          onClick={() => { setModelDropdownOpen(!modelDropdownOpen); setModelSearch(""); }}
                          className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-white/50 hover:text-white/80 transition-colors cursor-pointer max-w-[200px]"
                        >
                          <span className="truncate">{selectedLabel}</span>
                          <svg
                            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                            className={`shrink-0 transition-transform ${modelDropdownOpen ? "rotate-180" : ""}`}
                          >
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </button>

                        <GlassDropdown open={modelDropdownOpen} onClose={handleModelDropdownClose} anchorRef={modelBtnRef} side="top" align="right" width={256}>
                            <div className="p-2 border-b border-white/[0.06]">
                              <input
                                type="text"
                                placeholder="Search models..."
                                value={modelSearch}
                                onChange={(e) => setModelSearch(e.target.value)}
                                autoFocus
                                className="w-full px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs outline-none focus:border-white/25 transition-colors placeholder:text-white/25"
                              />
                            </div>
                            <div className="max-h-60 overflow-y-auto py-1">
                              {Object.entries(filteredGrouped).map(([provider, models]) => (
                                <div key={provider}>
                                  <div className="px-3 py-1.5 text-[10px] font-semibold text-white/30 uppercase tracking-wider">
                                    {provider.charAt(0).toUpperCase() + provider.slice(1)}
                                  </div>
                                  {models.map((m) => {
                                    const value = getModelValue(m);
                                    const isReasoning = m.tags?.includes("reasoning");
                                    return (
                                      <button
                                        key={m.id}
                                        type="button"
                                        onClick={() => {
                                          setSelectedModel(value);
                                          setModelDropdownOpen(false);
                                          setModelSearch("");
                                        }}
                                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                                          selectedModel === value
                                            ? "bg-violet-600/30 text-white"
                                            : "text-white/60 hover:bg-white/5 hover:text-white/90"
                                        }`}
                                      >
                                        {m.name}{isReasoning ? <span title="Supports reasoning">{" "}✦</span> : ""}
                                      </button>
                                    );
                                  })}
                                </div>
                              ))}
                              {Object.keys(filteredGrouped).length === 0 && (
                                <p className="px-3 py-3 text-xs text-white/30 text-center">No model found</p>
                              )}
                            </div>
                        </GlassDropdown>
                      </>
                    );
                  })()}
                </div>
              )}
              <button
                type="submit"
                disabled={isLoading || !input.trim()}
                className="p-1.5 rounded-lg bg-white text-black hover:bg-white/90 disabled:bg-white/10 disabled:text-white/20 disabled:cursor-not-allowed transition-colors shrink-0 cursor-pointer"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5" />
                  <path d="M5 12l7-7 7 7" />
                </svg>
              </button>
              </div>
            </div>
          </form>
          </div>
        </div>
      </div>

      {proxyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="border border-white/15 rounded-lg p-5 w-full max-w-md mx-4 shadow-2xl" style={{ background: "rgba(10,10,10,0.5)", backdropFilter: "blur(20px) saturate(1.5)", WebkitBackdropFilter: "blur(20px) saturate(1.5)" }}>
            <h3 className="text-sm font-semibold text-white mb-1">Configure Proxy</h3>
            <p className="text-xs text-white/50 mb-4">
              Choose between Proxy Online (tunnel) or Proxy Local mode
            </p>

            <div className="space-y-3">
              {/* Section Proxy Online */}
              <div className={`p-3 rounded-md border ${tunnelUrl.trim() ? 'bg-blue-500/10 border-blue-500/30' : 'bg-white/5 border-white/10'}`}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm">🔵</span>
                  <span className={`text-xs font-medium ${tunnelUrl.trim() ? 'text-blue-400' : 'text-white/60'}`}>
                    Proxy Online (Tunnel)
                  </span>
                  {tunnelUrl.trim() && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-blue-500/20 text-blue-300 rounded">Active</span>
                  )}
                </div>
                <label className="block text-xs text-white/60 mb-1">Tunnel URL</label>
                <input
                  type="url"
                  value={tunnelUrl}
                  onChange={(e) => setTunnelUrl(e.target.value)}
                  placeholder="https://your-tunnel.trycloudflare.com"
                  className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
                />
                <p className="text-[10px] text-white/40 mt-1">
                  Will use: {tunnelUrl.trim() ? `${tunnelUrl.replace(/\/$/, '')}/proxy-local/{service}/mcp` : '{tunnel}/proxy-local/{service}/mcp'}
                </p>
              </div>

              {/* Section Proxy Local */}
              <div className={`p-3 rounded-md border ${(localFigmaMcpUrl.trim() || localCodeMcpUrl.trim()) ? 'bg-amber-500/10 border-amber-500/30' : 'bg-white/5 border-white/10'}`}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm">🟢</span>
                  <span className={`text-xs font-medium ${(localFigmaMcpUrl.trim() || localCodeMcpUrl.trim()) ? 'text-amber-400' : 'text-white/60'}`}>
                    Proxy Local
                  </span>
                  {(localFigmaMcpUrl.trim() || localCodeMcpUrl.trim()) && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/20 text-amber-300 rounded">Active</span>
                  )}
                </div>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-white/60 mb-1">Local Figma MCP URL</label>
                    <input
                      type="url"
                      value={localFigmaMcpUrl}
                      onChange={(e) => setLocalFigmaMcpUrl(e.target.value)}
                      placeholder={process.env.NEXT_PUBLIC_LOCAL_MCP_FIGMA_URL || ""}
                      className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-white/60 mb-1">Local Code MCP URL</label>
                    <input
                      type="url"
                      value={localCodeMcpUrl}
                      onChange={(e) => setLocalCodeMcpUrl(e.target.value)}
                      placeholder={process.env.NEXT_PUBLIC_LOCAL_MCP_CODE_URL || ""}
                      className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-white/40 mt-2">
                  Will use: {process.env.NEXT_PUBLIC_PROXY_LOCAL_FIGMA_MCP?.replace('/figma/mcp', '/{service}/mcp') || 'http://localhost:3000/proxy-local/{service}/mcp'}
                </p>
              </div>

              <div>
                <label className="block text-xs text-white/60 mb-1">Secret</label>
                <input
                  type="password"
                  value={tunnelSecret}
                  onChange={(e) => setTunnelSecret(e.target.value)}
                  placeholder="your-secret-key"
                  className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setProxyModalOpen(false)}
                className="flex-1 px-4 py-2 text-sm text-white/60 hover:text-white hover:bg-white/5 rounded-md transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (tunnelUrl.trim()) {
                    const baseUrl = tunnelUrl.trim().replace(/\/$/, '');
                    setFigmaMcpUrl(`${baseUrl}/proxy-local/figma/mcp`);
                    setCodeProjectPath(`${baseUrl}/proxy-local/code/mcp`);
                    // Keep local URLs to send X-MCP-*-URL headers
                    // The server will use these headers to forward to the correct URLs
                  } else {
                    if (localFigmaMcpUrl.trim()) {
                      setFigmaMcpUrl(process.env.NEXT_PUBLIC_PROXY_LOCAL_FIGMA_MCP);
                    }
                    if (localCodeMcpUrl.trim()) {
                      setCodeProjectPath(process.env.NEXT_PUBLIC_PROXY_LOCAL_CODE_MCP);
                    }
                  }
                  setProxyModalOpen(false);
                }}
                className="flex-1 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingInvites.length > 0 && (
        <OrchestrationInviteModal
          invite={pendingInvites[0]}
          onAccept={acceptInvite}
          onDecline={declineInvite}
        />
      )}
    </div>
  );
}