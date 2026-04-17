"use client";

import { useState } from "react";

export function ToolCallBlock({ toolName, input, output, isError }: { toolName: string; input?: Record<string, unknown>; output?: unknown; isError?: boolean }) {
  const [open, setOpen] = useState(false);
  const [visibleLines, setVisibleLines] = useState(50);
  const CHUNK = 50;

  const outputText = (() => {
    if (!output) return null;
    if (typeof output === "string") {
      try { return JSON.stringify(JSON.parse(output), null, 2); } catch { return output; }
    }
    const o = output as { content?: { type: string; text: string }[] };
    if (o.content && Array.isArray(o.content)) {
      const text = o.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
    }
    return JSON.stringify(output, null, 2);
  })();

  const outputLines = outputText ? outputText.split("\n") : [];
  const totalLines = outputLines.length;
  const hasMore = totalLines > visibleLines;
  const displayedText = totalLines > CHUNK ? outputLines.slice(0, visibleLines).join("\n") : outputText;

  const isWebSearch = toolName === "web_search";
  const hasInput = !!input;

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
