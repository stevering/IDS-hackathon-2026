"use client";

import { useState } from "react";

export function ThinkingBlock({ text, isLast, isStreaming }: { text: string; isLast: boolean; isStreaming: boolean }) {
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
