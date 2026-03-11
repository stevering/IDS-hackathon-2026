"use client";

import type { AgentRole } from "@/types/orchestration";

type CollaboratorInfo = {
  clientId: string;
  shortId: string;
  label: string;
  status: "invited" | "active" | "completed" | "standby";
};

type Props = {
  role: AgentRole;
  orchestratorShortId?: string;
  collaborators?: CollaboratorInfo[];
  taskDescription?: string;
  timerRemainingMs?: number | null;
  onCancel?: () => void;
};

/** Format milliseconds as MM:SS */
function formatTimer(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Status bar displayed at the top of the chat when an orchestration is active.
 * Shows the current role, connected collaborators (orchestrator view),
 * or the assigned task (collaborator view), plus a countdown timer.
 */
export function OrchestrationStatusBar({
  role,
  orchestratorShortId,
  collaborators,
  taskDescription,
  timerRemainingMs,
  onCancel,
}: Props) {
  if (role === "idle") return null;

  const isOrchestrator = role === "orchestrator";
  const hasTimer = timerRemainingMs != null && timerRemainingMs >= 0;
  const isLowTime = hasTimer && timerRemainingMs < 60_000; // < 1 min

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 text-xs border-b border-white/30 ${
        isOrchestrator
          ? "bg-amber-500/5 text-amber-300/80"
          : "bg-violet-500/5 text-violet-300/80"
      }`}
    >
      {/* Role badge */}
      <span
        className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${
          isOrchestrator
            ? "bg-amber-500/15 text-amber-400"
            : "bg-violet-500/15 text-violet-400"
        }`}
      >
        {isOrchestrator ? "Orchestrator" : "Collaborator"}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0 truncate">
        {isOrchestrator && collaborators ? (
          <span>
            {collaborators.length === 0
              ? "No collaborators yet"
              : collaborators.map((c, i) => (
                  <span key={c.clientId}>
                    {i > 0 && ", "}
                    <span
                      className={
                        c.status === "active"
                          ? "text-emerald-400/70"
                          : c.status === "standby"
                          ? "text-amber-400/60"
                          : c.status === "completed"
                          ? "text-white/30"
                          : "text-white/40"
                      }
                    >
                      {c.shortId}
                    </span>
                    {c.status === "invited" && (
                      <span className="text-white/30 ml-0.5">(pending)</span>
                    )}
                    {c.status === "standby" && (
                      <span className="text-amber-400/40 ml-0.5">(standby)</span>
                    )}
                  </span>
                ))}
          </span>
        ) : (
          <span className="truncate">
            {taskDescription ? (
              <>Task from {orchestratorShortId}: {taskDescription}</>
            ) : (
              <>Working for {orchestratorShortId}</>
            )}
          </span>
        )}
      </div>

      {/* Timer chrono */}
      {hasTimer && (
        <span
          className={`shrink-0 tabular-nums font-mono text-[11px] px-1.5 py-0.5 rounded ${
            isLowTime
              ? "bg-red-500/15 text-red-400 animate-pulse"
              : "bg-white/5 text-white/40"
          }`}
          title="Time remaining in collaborative session"
        >
          {formatTimer(timerRemainingMs)}
        </span>
      )}

      {/* Cancel button (orchestrator only) */}
      {onCancel && (
        <button
          onClick={onCancel}
          className="shrink-0 text-white/30 hover:text-white/60 transition-colors cursor-pointer"
          title="Cancel orchestration"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
