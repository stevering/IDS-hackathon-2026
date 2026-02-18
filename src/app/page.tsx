"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useRef, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

type TextSegment = { type: "text"; content: string };
type ImageSegment = { type: "image"; src: string; complete: boolean };
type Segment = TextSegment | ImageSegment;

type ThinkingSegment = { kind: "thinking"; text: string };
type ContentSegment = { kind: "content"; text: string };
type DetailsSegment = { kind: "details"; text: string; streaming: boolean };
type QCMSegment = { kind: "qcm"; choices: string[] };
type MCPErrorSegment = { kind: "mcp-error"; errorText: string };
type MCPStatusSegment = { kind: "mcp-status"; status: "connecting" | "connected" | "error" };
type StructuredSegment = ThinkingSegment | ContentSegment | DetailsSegment | QCMSegment | MCPErrorSegment | MCPStatusSegment;

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
          <ReactMarkdown remarkPlugins={[remarkGfm/*, remarkBreaks*/]}>{text}</ReactMarkdown>
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

  // Nettoyer les balises orphelines avant parsing (hors streaming)
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

  const mcpErrorRegex = /\[MCP_ERROR_BLOCK\]([\s\S]*?)\[\/MCP_ERROR_BLOCK\]/g;
  while ((match = mcpErrorRegex.exec(cleanedText)) !== null) {
    mcpErrorBlocks.push({ index: match.index, length: match[0].length, errorText: match[1].trim() });
  }

  // Parser les statuts MCP - ne garder que le dernier
  const mcpStatusRegex = /\[MCP_STATUS:(\w+)\]/g;
  let lastMcpStatus: { index: number; length: number; status: "connecting" | "connected" | "error" } | null = null;
  while ((match = mcpStatusRegex.exec(cleanedText)) !== null) {
    const status = match[1] as "connecting" | "connected" | "error";
    lastMcpStatus = { index: match.index, length: match[0].length, status };
  }
  if (lastMcpStatus) {
    mcpStatusBlocks.push(lastMcpStatus);
  }

  // Retirer les balises MCP du texte pour ne pas les afficher
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
    } else {
      segments.push({ kind: block.kind, text: block.text });
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
 * Supprime les balises orphelines (ouvrantes sans fermante ou fermantes sans ouvrante)
 * pour éviter qu'elles s'affichent dans le chat.
 */
function cleanOrphanedTags(text: string): string {
  let cleaned = text;

  // Détecter les balises DETAILS_START sans fermeture
  const detailsOpens = [...cleaned.matchAll(/<!-- DETAILS_START -->/g)];
  const detailsCloses = [...cleaned.matchAll(/<!-- DETAILS_END -->/g)].map(m => m.index!);

  for (const match of detailsOpens) {
    const openIdx = match.index!;
    const hasMatchingClose = detailsCloses.some(closeIdx => closeIdx > openIdx);
    if (!hasMatchingClose) {
      // Supprimer la balise ouvrante orpheline
      cleaned = cleaned.replace(/<!-- DETAILS_START -->/, "");
    }
  }

  // Détecter les balises DETAILS_END sans ouverture
  const detailsOpensAfterClean = [...cleaned.matchAll(/<!-- DETAILS_START -->/g)].map(m => m.index!);
  const detailsClosesAfterClean = [...cleaned.matchAll(/<!-- DETAILS_END -->/g)];

  for (const match of detailsClosesAfterClean) {
    const closeIdx = match.index!;
    const hasMatchingOpen = detailsOpensAfterClean.some(openIdx => openIdx < closeIdx);
    if (!hasMatchingOpen) {
      // Supprimer la balise fermante orpheline
      cleaned = cleaned.replace(/<!-- DETAILS_END -->/, "");
    }
  }

  // Détecter les balises QCM_START sans fermeture
  const qcmOpens = [...cleaned.matchAll(/<!-- QCM_START -->/g)];
  const qcmCloses = [...cleaned.matchAll(/<!-- QCM_END -->/g)].map(m => m.index!);

  for (const match of qcmOpens) {
    const openIdx = match.index!;
    const hasMatchingClose = qcmCloses.some(closeIdx => closeIdx > openIdx);
    if (!hasMatchingClose) {
      // Supprimer la balise ouvrante orpheline et son contenu jusqu'à la fin
      cleaned = cleaned.replace(/<!-- QCM_START -->[\s\S]*$/, "");
    }
  }

  // Détecter les balises QCM_END sans ouverture
  const qcmOpensAfterClean = [...cleaned.matchAll(/<!-- QCM_START -->/g)].map(m => m.index!);
  const qcmClosesAfterClean = [...cleaned.matchAll(/<!-- QCM_END -->/g)];

  for (const match of qcmClosesAfterClean) {
    const closeIdx = match.index!;
    const hasMatchingOpen = qcmOpensAfterClean.some(openIdx => openIdx < closeIdx);
    if (!hasMatchingOpen) {
      // Supprimer la balise fermante orpheline
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

  // Pour web_search, indiquer que la recherche est faite automatiquement par le modèle
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
  if (status === "connected") return null; // Ne rien afficher une fois connecté

  const isError = status === "error";

  return (
    <div className={`my-3 p-3 rounded-lg border ${isError ? "bg-red-500/5 border-red-500/20" : "bg-blue-500/5 border-blue-500/20"}`}>
      <div className="flex items-center gap-3">
        {isError ? (
          <svg className="h-5 w-5 text-red-400/70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ) : (
          <svg className="animate-spin h-5 w-5 text-blue-400/70 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        <div className="flex-1">
          <h4 className={`text-sm font-medium ${isError ? "text-red-300/90" : "text-blue-300/90"}`}>
            {isError ? "MCP Connection Failed" : "Connecting to MCP servers..."}
          </h4>
          <p className="text-xs text-white/60">
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

export default function Home() {
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
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState<"grok-4-1-fast-reasoning" | "grok-4-1-fast-non-reasoning">("grok-4-1-fast-non-reasoning");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectionGlow, setSelectionGlow] = useState(false);
  const [proxyModalOpen, setProxyModalOpen] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelSecret, setTunnelSecret] = useState(process.env.NEXT_PUBLIC_MCP_TUNNEL_SECRET);
  const [localFigmaMcpUrl, setLocalFigmaMcpUrl] = useState(process.env.NEXT_PUBLIC_LOCAL_MCP_FIGMA_URL || "");
  const [localCodeMcpUrl, setLocalCodeMcpUrl] = useState(process.env.NEXT_PUBLIC_LOCAL_MCP_CODE_URL || "");

  // MCP Toggles - enabled/disabled state
  const [enabledMcps, setEnabledMcps] = useState<Record<string, boolean>>({
    figma: true,
    figmaConsole: false,
    github: false,
    code: true,
  });

  // Load enabled MCPs from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('guardian-enabled-mcps');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setEnabledMcps(prev => ({ ...prev, ...parsed }));
      } catch (e) {
        console.error('Failed to parse enabled MCPs from localStorage:', e);
      }
    }
  }, []);

  // Save enabled MCPs to localStorage when changed
  useEffect(() => {
    localStorage.setItem('guardian-enabled-mcps', JSON.stringify(enabledMcps));
  }, [enabledMcps]);

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
  const tunnelSecretRef = useRef(tunnelSecret);
  tunnelSecretRef.current = tunnelSecret;
  const localFigmaMcpUrlRef = useRef(localFigmaMcpUrl);
  localFigmaMcpUrlRef.current = localFigmaMcpUrl;
  const localCodeMcpUrlRef = useRef(localCodeMcpUrl);
  localCodeMcpUrlRef.current = localCodeMcpUrl;
  const enabledMcpsRef = useRef(enabledMcps);
  enabledMcpsRef.current = enabledMcps;

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data && typeof event.data === "object" && "selectedNode" in event.data) {
        const url = event.data.selectedNode;
        if (typeof url === "string" || url === null) {
          setSelectedNode(url);
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

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
          return headers;
        },
        body: () => ({ figmaMcpUrl: figmaMcpUrlRef.current || (figmaOAuthRef.current ? "https://mcp.figma.com/mcp" : ""), figmaAccessToken: figmaAccessTokenRef.current, codeProjectPath: codeProjectPathRef.current, figmaOAuth: figmaOAuthRef.current, model: selectedModelRef.current, selectedNode: selectedNodeRef.current, tunnelSecret: tunnelSecretRef.current, enabledMcps: enabledMcpsRef.current }),
      }),
    [],
  );

  const { messages, sendMessage, status, error, setMessages } = useChat({ transport });

  const isLoading = status === "submitted" || status === "streaming";

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const threshold = 40;
    shouldAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  useEffect(() => {
    fetch("/api/auth/figma-mcp/status", {
      headers: {
        "X-Auth-Token": tunnelSecret || "",
      },
    })
      .then((r) => r.json())
      .then((d) => setFigmaOAuth(d.connected))
      .catch(() => {});
    fetch("/api/auth/southleft-mcp/status", {
      headers: {
        "X-Auth-Token": tunnelSecret || "",
      },
    })
      .then((r) => r.json())
      .then((d) => setSouthleftOAuth(d.connected))
      .catch(() => {});

    fetch("/api/auth/github-mcp/status", {
      headers: {
        "X-Auth-Token": tunnelSecret || "",
      },
    })
      .then((r) => r.json())
      .then((d) => setGithubOAuth(d.connected))
      .catch(() => {});
  }, [tunnelSecret]);

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

  // Fonction pour détecter le mode de connexion MCP
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
    <div className="relative flex h-screen bg-[#0a0a0a] text-white overflow-hidden">
      <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
        <div className="wave-bg-layer wave-bg-1" />
        <div className="wave-bg-layer wave-bg-2" />
        <div className="wave-bg-layer wave-bg-3" />
        <div className="wave-bg-noise" />
      </div>
      {settingsOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSettingsOpen(false)}
        />
      )}
      <div
        className={`${settingsOpen ? "w-80 translate-x-0" : "w-0 -translate-x-full md:translate-x-0"} fixed md:relative z-50 md:z-auto h-full transition-all duration-200 overflow-hidden glass-sidebar`}
      >
        <div className="p-4 w-80">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">
            MCP Connections
          </h2>

          {/* MCP Toggles */}
          <div className="mb-4 p-3 bg-white/5 rounded-md border border-white/10">
            <p className="text-xs text-white/50 mb-2 font-medium">Enable MCPs</p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabledMcps.figma}
                  onChange={() => setEnabledMcps(prev => ({ ...prev, figma: !prev.figma }))}
                  className="w-4 h-4 rounded border-white/20 bg-white/5 text-violet-500 focus:ring-violet-500/50"
                />
                <span className="text-xs text-white/70">Figma MCP</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabledMcps.figmaConsole}
                  onChange={() => setEnabledMcps(prev => ({ ...prev, figmaConsole: !prev.figmaConsole }))}
                  className="w-4 h-4 rounded border-white/20 bg-white/5 text-violet-500 focus:ring-violet-500/50"
                />
                <span className="text-xs text-white/70">Figma Console (Southleft)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabledMcps.github}
                  onChange={() => setEnabledMcps(prev => ({ ...prev, github: !prev.github }))}
                  className="w-4 h-4 rounded border-white/20 bg-white/5 text-violet-500 focus:ring-violet-500/50"
                />
                <span className="text-xs text-white/70">GitHub MCP</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabledMcps.code}
                  onChange={() => setEnabledMcps(prev => ({ ...prev, code: !prev.code }))}
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
                      }).then(() => setFigmaOAuth(false));
                    }}
                    className="px-2 py-2 text-xs text-red-400 hover:bg-red-500/10 rounded-md transition-colors cursor-pointer"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <button
                  title="OAuth is currently disabled Due to limitation of Figma MCP server"
                  onClick={async () => {
                    // Set auth token cookie before OAuth redirect
                    if (tunnelSecret) {
                      try {
                        await fetch("/api/auth/set-token", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ token: tunnelSecret }),
                        });
                      } catch (e) {
                        console.error("[Figma] Failed to set auth cookie:", e);
                        return;
                      }
                    }
                    
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
                    // Redirect to the auth flow (will use DCR client if available, else fallback)
                    window.location.href = "/api/auth/figma-mcp";
                  }}
                  className="block w-full text-center bg-[#a259ff]/20 border border-[#a259ff]/30 hover:bg-[#a259ff]/30 rounded-md px-3 py-2 text-sm text-[#a259ff] transition-colors cursor-pointer"
                >
                  Sign in with Figma
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
        onClick={() => {
          fetch("/api/auth/southleft-mcp/status", {
            method: "DELETE",
            headers: {
              "X-Auth-Token": tunnelSecret || "",
            },
          }).then(() => setSouthleftOAuth(false));
        }}
        className="px-2 py-2 text-xs text-red-400 hover:bg-red-500/10 rounded-md transition-colors cursor-pointer"
      >
        Disconnect
      </button>
    </div>
  ) : (
    <button
      onClick={async () => {
        if (tunnelSecret) {
          await fetch("/api/auth/set-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: tunnelSecret }),
          });
        }
        window.location.href = "/api/auth/southleft-mcp";
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
                Fallback if OAuth not used. Also reads FIGMA_ACCESS_TOKEN from .env.local
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
          }).then(() => setGithubOAuth(false));
        }}
        className="px-2 py-2 text-xs text-red-400 hover:bg-red-500/10 rounded-md transition-colors cursor-pointer"
      >
        Disconnect
      </button>
    </div>
  ) : (
    <button
      onClick={async () => {
        if (tunnelSecret) {
          await fetch("/api/auth/set-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: tunnelSecret }),
          });
        }
        window.location.href = "/api/auth/github-mcp";
      }}
      className="w-full text-center bg-gradient-to-r from-gray-600/20 to-black/20 border border-gray-500/30 hover:from-gray-600/30 hover:to-black/30 rounded-md px-3 py-2.5 text-sm text-gray-300 font-medium transition-all hover:shadow-lg"
    >
      🌐 Sign in with GitHub
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

      <div className="flex-1 flex flex-col min-w-0 relative z-10">
        <header className="flex items-center justify-between px-3 sm:px-4 py-3 glass-header">
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
              <h1 className="text-sm font-semibold truncate">DS AI Guardian</h1>
              <p className="text-xs text-white/40 hidden sm:block">
                [Figma ↔ Code] Design System drift detector
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {messages.length > 0 && (
              <button
                onClick={() => setMessages([])}
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
            <div
              className={`w-2 h-2 rounded-full ${figmaConnected ? "bg-emerald-400" : "bg-white/20"}`}
              title={`Figma MCP: ${figmaConnected ? "configured" : "not configured"}`}
            />
            <span className="text-xs text-white/30 hidden sm:inline">Figma</span>
            <div
              className={`w-2 h-2 rounded-full ml-1 sm:ml-2 ${codeConnected ? "bg-emerald-400" : "bg-white/20"}`}
              title={`Code MCP: ${codeConnected ? "configured" : "not configured"}`}
            />
            <span className="text-xs text-white/30 hidden sm:inline">Code</span>
          </div>
        </header>

        <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 sm:py-6">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="text-4xl mb-4">🛡️</div>
              <h2 className="text-lg font-semibold mb-2">
                Welcome to DS AI Guardian
              </h2>
              <p className="text-sm text-white/40 max-w-md mb-6">
                I can compare your Figma design system components with their
                code implementation to detect property and variant drift.
              </p>
              <div className="space-y-2 text-sm text-white/30">
                <p>Try asking:</p>
                <button
                  onClick={() => sendMessage({ text: "Check the Button component" })}
                  className="block mx-auto px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
                >
                  &quot;Check the Button component&quot;
                </button>
                <button
                  onClick={() => sendMessage({ text: "List all components available in Figma" })}
                  className="block mx-auto px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
                >
                  &quot;List all components available in Figma&quot;
                </button>
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className={`mb-4 ${m.role === "user" ? "flex justify-end" : ""}`}
            >
              <div
                className={`max-w-full sm:max-w-[80%] rounded-lg px-3 sm:px-4 py-2.5 sm:py-3 text-sm leading-relaxed ${
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
                          
                          // content kind
                          const imageSegments = parseTextWithImages(structSeg.text, isLoading && isLastMsg);
                          return (
                            <div key={sj} className="markdown-body overflow-x-auto">
                              {imageSegments.map((seg, j) => {
                                if (seg.type === "image") {
                                  if (!seg.complete) {
                                    return (
                                      <div key={j} className="my-3 flex flex-col items-center justify-center w-full max-w-64 h-48 bg-white/5 border border-white/10 rounded-lg">
                                        <svg className="animate-spin h-8 w-8 text-white/30 mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                        </svg>
                                        <span className="text-xs text-white/30">Loading image…</span>
                                      </div>
                                    );
                                  }
                                  return (
                                    <img
                                      key={j}
                                      src={seg.src}
                                      alt="Generated image"
                                      className="my-3 max-w-full rounded-lg border border-white/10"
                                    />
                                  );
                                }
                                return (
                                  <ReactMarkdown key={j} remarkPlugins={[remarkGfm/*, remarkBreaks*/]}>
                                    {seg.content}
                                  </ReactMarkdown>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    );
                  }
                  // Tool calls typés du Responses API (ex: tool-web_search)
                  if (part.type?.startsWith("tool-")) {
                    const toolName = part.type.replace("tool-", "");
                    const p = part as { type: string; toolCallId: string; state: string; input?: Record<string, unknown>; output?: unknown; errorText?: string; providerExecuted?: boolean };

                    // Si le provider a exécuté le tool mais qu'on n'a pas reçu output-available,
                    // on considère que c'est terminé quand on reçoit du texte après
                    const hasTextAfter = m.parts?.slice(i + 1).some((nextPart: { type?: string }) => nextPart.type === "text");
                    const isProviderExecuted = (p as unknown as { providerExecuted?: boolean }).providerExecuted === true;

                    // Si providerExecuted=true, le tool est terminé (exécuté côté serveur par xAI)
                    // On n'attend pas output-available qui n'arrive jamais pour les tools natifs xAI
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

                    // Si le provider a exécuté le tool mais qu'on n'a pas reçu output-available,
                    // on considère que c'est terminé quand on reçoit du texte après
                    const hasTextAfter = m.parts?.slice(i + 1).some((nextPart: { type?: string }) => nextPart.type === "text");
                    const isProviderExecuted = p.providerExecuted === true;

                    // Si providerExecuted=true, le tool est terminé (exécuté côté serveur par xAI)
                    // On n'attend pas output-available qui n'arrive jamais pour les tools natifs xAI
                    if (isProviderExecuted || p.state === "output-available") {
                      return (
                        <ToolCallBlock
                          key={i}
                          toolName={p.toolName}
                          input={p.input}
                          output={p.output || { content: [{ type: "text", text: "Résultat intégré dans la réponse" }] }}
                          isError={p.output?.isError}
                        />
                      );
                    }

                    // Gérer tous les états possibles des tool calls
                    switch (p.state) {
                      case "input-streaming":
                      case "input-available":
                        // Tool call en cours d'exécution
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
          ))}

          {isLoading && <ThinkingIndicator />}

          {selectedNode && (
            <div className={`mb-4 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-xs text-purple-300/80 italic${selectionGlow ? " teleport-in" : ""}`}>
              <span className="shrink-0 mt-0.5">👁️</span>
              <div>
                <span>Selection changed in Figma — </span>
                <span className="text-purple-200/90 font-medium not-italic break-all">{selectedNode}</span>
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

          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400 break-words">
              Error: {error.message}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <form
          onSubmit={onSubmit}
          className="px-3 sm:px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] glass-input-bar"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-white/40">Model:</span>
            <div className="flex rounded-md overflow-hidden border border-white/10">
              <button
                type="button"
                onClick={() => setSelectedModel("grok-4-1-fast-reasoning")}
                className={`px-3 py-1 text-xs transition-colors cursor-pointer ${selectedModel === "grok-4-1-fast-reasoning" ? "bg-blue-600 text-white" : "bg-white/5 text-white/50 hover:bg-white/10"}`}
              >
                Reasoning
              </button>
              <button
                type="button"
                onClick={() => setSelectedModel("grok-4-1-fast-non-reasoning")}
                className={`px-3 py-1 text-xs transition-colors cursor-pointer ${selectedModel === "grok-4-1-fast-non-reasoning" ? "bg-blue-600 text-white" : "bg-white/5 text-white/50 hover:bg-white/10"}`}
              >
                Non-Reasoning
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                const maxH = window.innerHeight * 0.1;
                e.target.style.height = Math.min(e.target.scrollHeight, maxH) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e);
                }
              }}
              placeholder="Ask Guardian to check a component..."
              className={`flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-3 sm:px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30 resize-none overflow-y-auto ${isLoading ? "opacity-50" : ""}`}
              readOnly={isLoading}
              rows={1}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="px-3 sm:px-4 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-white/5 disabled:text-white/20 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors shrink-0 cursor-pointer"
            >
              Send
            </button>
          </div>
        </form>
      </div>

      {proxyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1a1a2e] border border-white/10 rounded-lg p-5 w-full max-w-md mx-4 shadow-2xl">
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
                    // Garder les URLs locales pour envoyer les headers X-MCP-*-URL
                    // Le serveur utilisera ces headers pour forwarder vers les bonnes URLs
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
    </div>
  );
}