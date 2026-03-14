"use client";

import { useEffect, useState } from "react";

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
  completedStatus: "completed" | "cancelled" | "timed_out" | null;
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
      : completedStatus === "cancelled"
        ? "Orchestration cancelled"
        : "Orchestration timed out"
    : "Orchestration in progress";

  const statusColorClass = isRunning
    ? "text-amber-300/80"
    : completedStatus === "completed"
      ? "text-emerald-300/80"
      : "text-amber-300/80";

  const bannerBg = isInOrchestrationConversation
    ? "bg-violet-500/5"
    : isRunning
      ? "bg-amber-500/5"
      : completedStatus === "completed"
        ? "bg-emerald-500/5"
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

        {/* Right: status + timer */}
        <div className={`ml-auto flex items-center gap-2 ${statusColorClass}`}>
          <StatusIcon />
          <span className="truncate">{statusLabel}</span>
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
      <TimerDisplay />
      <span className="font-medium shrink-0 ml-auto">
        View &rarr;
      </span>
    </button>
  );
}

// Keep the old named export as an alias so any stale imports still compile.
// The OrchestrationBackBanner is no longer needed — use OrchestrationBanner
// with isInOrchestrationConversation=true instead.
export const OrchestrationBackBanner = OrchestrationBanner;
