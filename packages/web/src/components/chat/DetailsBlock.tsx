"use client";

import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fixUnpairedMarkdown } from "@/lib/markdown-utils";
import { markdownComponents } from "./markdown-components";

export function DetailsBlock({ text, isStreaming }: { text: string; isStreaming: boolean }) {
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
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{fixUnpairedMarkdown(text)}</ReactMarkdown>
          <div ref={detailsEndRef} />
        </div>
      )}
    </div>
  );
}
