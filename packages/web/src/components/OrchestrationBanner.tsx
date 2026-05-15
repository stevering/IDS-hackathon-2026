"use client";

import { useEffect, useState } from "react";
import type { AgentViewState } from "@guardian/orchestrations";

type Props = {
  /** Whether an orchestration exists (active or completed) */
  active: boolean;
  /** Whether the user is currently viewing the orchestration conversation */
  isInOrchestrationConversation: boolean;
  /** Callback to switch to the orchestration conversation */
  onView: () => void;
  /** Callback to switch back to the chat conversation */
  onBack: () => void;
  /** Timer remaining in ms (from SSE stream) */
  timerRemainingMs: number | null;
  /** Completion status (null while still running) */
  completedStatus: "completed" | "completed_with_errors" | "failed" | "cancelled" | "timed_out" | null;
  /** Error detail when failed */
  errorMessage?: string | null;
  /** Current view mode (chat vs developer) */
  viewMode?: "chat" | "developer";
  /** Callback to toggle view mode */
  onToggleViewMode?: () => void;
  /** Agent list with status */
  agents?: AgentViewState[];
};

/**
 * Unified orchestration banner shown in the header whenever an orchestration
 * exists. Adapts its layout depending on whether the user is viewing the
 * orchestration conversation or the regular chat.
 *
 * - Chat view: spinner/checkmark + status label + timer + "View ->"
 * - Orchestration view: "<- Back to chat" on left, status + timer on right
 */
export function OrchestrationBanner({
  active,
  isInOrchestrationConversation,
  onView,
  onBack,
  timerRemainingMs,
  completedStatus,
  errorMessage,
  viewMode,
  onToggleViewMode,
  agents,
}: Props) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active || completedStatus) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [active, completedStatus]);

  if (!active) return null;

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const isRunning = !completedStatus;
  const statusLabel = completedStatus
    ? completedStatus === "completed"
      ? "Orchestration completed"
      : completedStatus === "completed_with_errors"
        ? "Orchestration completed with errors"
        : completedStatus === "failed"
          ? "Orchestration failed"
          : completedStatus === "cancelled"
            ? "Orchestration cancelled"
            : "Orchestration timed out"
    : "Orchestration in progress";

  const isSuccess = completedStatus === "completed";
  const isError = completedStatus === "failed" || completedStatus === "completed_with_errors";

  const statusColorClass = isRunning
    ? "text-amber-300/80"
    : isSuccess
      ? "text-emerald-300/80"
      : isError
        ? "text-red-300/80"
        : "text-amber-300/80";

  const bannerBg = isInOrchestrationConversation
    ? "bg-violet-500/5"
    : isRunning
      ? "bg-amber-500/5"
      : isSuccess
        ? "bg-emerald-500/5"
        : isError
          ? "bg-red-500/5"
          : "bg-amber-500/5";

  // Status icon (spinner or checkmark)
  const StatusIcon = () =>
    isRunning ? (
      <svg
        className="animate-spin h-3 w-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    ) : (
      <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );

  // Timer display
  const TimerDisplay = () => {
    if (!isRunning) return null;
    return (
      <span className="text-white/30 tabular-nums shrink-0">
        {timerRemainingMs !== null
          ? formatTime(Math.ceil(timerRemainingMs / 1000))
          : formatTime(elapsed)}
      </span>
    );
  };

  // ── Orchestration view: back button on left, status on right ──
  if (isInOrchestrationConversation) {
    return (
      <div
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs border-b border-white/10 ${bannerBg}`}
      >
        {/* Left: back to chat */}
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-violet-300/80 hover:text-violet-200 transition-colors cursor-pointer shrink-0"
        >
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M5 12l7-7M5 12l7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Back to chat</span>
        </button>

        {/* Center: view mode toggle */}
        {onToggleViewMode && (
          <div className="flex items-center gap-0.5 rounded-md border border-white/10 bg-white/[0.03] p-0.5">
            <button
              onClick={viewMode === "chat" ? undefined : onToggleViewMode}
              className={`text-[10px] px-2 py-0.5 rounded transition-colors cursor-pointer ${
                viewMode === "chat" ? "bg-white/10 text-white/70" : "text-white/30 hover:text-white/50"
              }`}
            >
              Chat
            </button>
            <button
              onClick={viewMode === "developer" ? undefined : onToggleViewMode}
              className={`text-[10px] px-2 py-0.5 rounded transition-colors cursor-pointer ${
                viewMode === "developer" ? "bg-white/10 text-white/70" : "text-white/30 hover:text-white/50"
              }`}
            >
              Dev
            </button>
          </div>
        )}

        {/* Center-right: agent dots */}
        {agents && agents.length > 0 && (
          <div className="flex items-center gap-1.5 ml-2">
            {agents.map((a) => {
              const dotColor =
                a.status === "completed" ? "bg-emerald-400" :
                a.status === "active" ? "bg-amber-400 animate-pulse" :
                a.status === "failed" || a.status === "interrupted" ? "bg-red-400" :
                "bg-white/25";
              return (
                <div key={a.shortId} className="flex items-center gap-1" title={`${a.label || a.shortId}: ${a.status}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                  <span className="text-[10px] text-white/40">{a.label || a.shortId}</span>
                </div>
              );
            })}
            <span className="text-[10px] text-white/25 ml-1">
              {agents.filter(a => a.status === "completed").length}/{agents.length}
            </span>
          </div>
        )}

        {/* Right: status + timer */}
        <div className={`ml-auto flex items-center gap-2 ${statusColorClass}`}>
          <StatusIcon />
          <span className="truncate">{statusLabel}</span>
          {isError && errorMessage && (
            <span className="text-red-400/60 truncate max-w-[300px]" title={errorMessage}>
              — {errorMessage}
            </span>
          )}
          <TimerDisplay />
        </div>
      </div>
    );
  }

  // ── Chat view: full clickable banner to switch to orchestration ──
  return (
    <button
      onClick={onView}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs border-b border-white/10 transition-colors cursor-pointer hover:bg-white/5 ${bannerBg} ${statusColorClass}`}
    >
      <StatusIcon />
      <span className="truncate">{statusLabel}</span>
      {isError && errorMessage && (
        <span className="text-red-400/60 truncate max-w-[200px]" title={errorMessage}>
          — {errorMessage}
        </span>
      )}
      <TimerDisplay />
      <span className="font-medium shrink-0 ml-auto">
        View &rarr;
      </span>
    </button>
  );
}
