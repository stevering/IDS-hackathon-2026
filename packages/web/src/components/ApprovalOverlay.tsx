"use client";

import { useState, useEffect, useRef } from "react";

type Props = {
  /** The code pending approval */
  code: string;
  /** Agent label (e.g. "Agent A1") */
  agentLabel?: string;
  /** Critical operations detected by guard */
  criticalOps: string[];
  /** Callback when user approves this single execution */
  onAllow: () => void;
  /** Callback when user approves all executions for this session */
  onAllowAll: () => void;
  /** Callback when user rejects the execution */
  onReject: () => void;
  /** Auto-reject timeout in seconds (default 30) */
  timeoutSeconds?: number;
};

/**
 * Approval overlay for Figma code execution.
 * Shows the pending code, critical warnings, and Allow/Reject buttons.
 * Auto-rejects after timeout.
 */
export function ApprovalOverlay({
  code,
  agentLabel,
  criticalOps,
  onAllow,
  onAllowAll,
  onReject,
  timeoutSeconds = 30,
}: Props) {
  const [remaining, setRemaining] = useState(timeoutSeconds);
  const rejectedRef = useRef(false);

  // Countdown timer
  useEffect(() => {
    setRemaining(timeoutSeconds);
    const interval = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          if (!rejectedRef.current) {
            rejectedRef.current = true;
            onReject();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [timeoutSeconds, onReject]);

  const isCritical = criticalOps.length > 0;

  return (
    <div className="mx-2 sm:mx-4 my-2 rounded-xl border overflow-hidden backdrop-blur-sm border-amber-500/30 bg-amber-500/5">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-500/20 bg-amber-500/10">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="shrink-0 text-amber-400"
        >
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <span className="text-xs font-medium text-amber-300">
          Code approval required
        </span>
        {agentLabel && (
          <span className="text-[10px] text-amber-400/60">
            from {agentLabel}
          </span>
        )}
        <span className="ml-auto text-xs tabular-nums text-amber-400/50">
          {remaining}s
        </span>
      </div>

      {/* Critical warnings */}
      {isCritical && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/20">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[10px] font-semibold text-red-400 uppercase tracking-wider">
              Critical operations detected
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {criticalOps.map((op, i) => (
              <span
                key={i}
                className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 border border-red-500/25 text-red-300 font-mono"
              >
                {op}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Code preview */}
      <div className="px-4 py-3 max-h-40 overflow-y-auto">
        <pre className="text-xs font-mono text-white/60 leading-relaxed whitespace-pre-wrap break-all">
          {code.length > 1000 ? code.slice(0, 1000) + "\n…" : code}
        </pre>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 bg-white/5">
        <div
          className="h-full bg-amber-500/50 transition-all duration-1000 ease-linear"
          style={{ width: `${(remaining / timeoutSeconds) * 100}%` }}
        />
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-white/[0.02]">
        <button
          onClick={onAllow}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-600/80 hover:bg-emerald-600 text-white transition-colors cursor-pointer"
        >
          Allow
        </button>
        <button
          onClick={onAllowAll}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 border border-emerald-500/30 transition-colors cursor-pointer"
        >
          Allow all (session)
        </button>
        <button
          onClick={() => {
            rejectedRef.current = true;
            onReject();
          }}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-600/30 hover:bg-red-600/50 text-red-300 border border-red-500/30 transition-colors cursor-pointer ml-auto"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
