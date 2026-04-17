"use client";

import { useState } from "react";

export function MCPErrorBlock({ errorText, onAskHelp }: { errorText: string; onAskHelp: () => void }) {
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
            I couldn&apos;t connect to some MCP servers. I won&apos;t be able to access your files or designs until this is resolved.
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
