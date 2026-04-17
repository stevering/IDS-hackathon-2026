"use client";

import { useState, useEffect } from "react";

export function ToolCallProgress({ toolName, input }: { toolName: string; input?: Record<string, unknown> }) {
  const [elapsed, setElapsed] = useState(0);
  const [open, setOpen] = useState(false);

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
  const hasInput = !!input && Object.keys(input).length > 0;

  return (
    <div className="my-2">
      <button
        onClick={() => hasInput && setOpen(!open)}
        className={`flex items-center gap-2 text-xs font-mono px-3 py-2 rounded w-full text-left min-w-0 ${
          hasInput ? "cursor-pointer" : ""
        } ${
          isStalled ? "bg-amber-500/10 border border-amber-500/20 text-amber-300/70" : "bg-white/5 text-white/50"
        }`}
      >
        <svg className="animate-spin h-3.5 w-3.5 text-amber-400/70 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-amber-400/70">🔧 Tool:</span>{" "}
        {toolName}
        {isStalled && <span className="text-amber-400/60 text-[10px]">slow response…</span>}
        {!open && hasInput && (
          <span className="truncate opacity-50 text-[10px] ml-1 min-w-0 flex-1">
            {Object.entries(input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ").slice(0, 60)}
          </span>
        )}
        {hasInput && (
          <svg className={`h-3 w-3 shrink-0 transition-transform ml-auto ${open ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="currentColor">
            <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
          </svg>
        )}
        <span className={`tabular-nums ${hasInput ? "" : "ml-auto"} ${isStalled ? "text-amber-400/50" : "text-white/30"}`}>{timeStr}</span>
      </button>
      {open && hasInput && (
        <div className="mt-1 ml-5">
          <div className="px-3 py-2 rounded text-xs leading-relaxed border-l-2 border-amber-500/20">
            <span className="text-white/30 font-medium block mb-1">Input:</span>
            <pre className="text-amber-200/50 font-mono whitespace-pre-wrap break-all">{JSON.stringify(input, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
