"use client";

/**
 * PhaseBubble — banner positioned above the composer showing the current
 * LLM phase with a stacked-ticker animation. Click to expand an accordion
 * with the history of all past phases in the current run and their timings.
 *
 * When the generation is complete (currentPhase is null but history exists),
 * the bubble stays visible with a static summary showing total duration and
 * step count, so the user can review what happened. It auto-hides when both
 * currentPhase is null AND history is empty (before any run or after reset).
 *
 * See useGuardianPhase.ts for how the current phase + history are derived
 * from the Temporal chat workflow state.
 */

import { useEffect, useRef, useState } from "react";

export type PhaseType = "prepare" | "reason" | "tool" | "write";

export type Phase = {
  type: PhaseType;
  label: string;
};

export type PhaseHistoryEntry = {
  phase: Phase;
  /** Duration of the phase in milliseconds. */
  duration: number;
};

type PhaseBubbleProps = {
  currentPhase: Phase | null;
  history: PhaseHistoryEntry[];
  onDismiss?: () => void;
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}m${rs.toString().padStart(2, "0")}s`;
}

/**
 * Stacked-ticker animation for the current phase label. Uses direct DOM
 * mutation via a ref (rather than React state) because we need two items
 * to coexist briefly during the slide transition — one leaving, one
 * entering — and driving that through React state would triple the
 * render work for what is essentially a CSS transition.
 */
function PhaseTicker({ phase }: { phase: Phase | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!phase) {
      // Phase went away — fade out any visible item.
      const activeEl = container.querySelector(".phase-item.active");
      if (activeEl) {
        activeEl.classList.remove("active");
        activeEl.classList.add("leaving");
        window.setTimeout(() => activeEl.remove(), 650);
      }
      lastKeyRef.current = null;
      return;
    }

    const newKey = `${phase.type}::${phase.label}`;
    if (lastKeyRef.current === newKey) return;
    lastKeyRef.current = newKey;

    // Slide the current active item up & out.
    const activeEl = container.querySelector(".phase-item.active");
    if (activeEl) {
      activeEl.classList.remove("active");
      activeEl.classList.add("leaving");
      window.setTimeout(() => activeEl.remove(), 650);
    }

    // Build and insert the new item below, then slide it up into place.
    const item = document.createElement("div");
    item.className = `phase-item entering phase-${phase.type}`;
    const icon = document.createElement("span");
    icon.className = "phase-icon";
    const label = document.createElement("span");
    label.textContent = phase.label;
    item.appendChild(icon);
    item.appendChild(label);
    container.appendChild(item);

    // Double rAF so the browser commits the "entering" style before we
    // flip to "active" — otherwise the transition would not fire.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        item.classList.remove("entering");
        item.classList.add("active");
      });
    });
  }, [phase]);

  return <div ref={containerRef} className="phase-line" />;
}

export function PhaseBubble({ currentPhase, history, onDismiss }: PhaseBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const prevRunningRef = useRef(false);

  const isRunning = currentPhase !== null;

  // Reset dismissed state when a new run starts.
  useEffect(() => {
    if (isRunning && !prevRunningRef.current) {
      setDismissed(false);
    }
    prevRunningRef.current = isRunning;
  }, [isRunning]);

  if (dismissed) return null;
  if (!currentPhase && history.length === 0) return null;

  const totalDuration = history.reduce((sum, h) => sum + h.duration, 0);

  return (
    <div
      className={`phase-bubble ${expanded ? "expanded" : ""} ${isRunning ? "" : "phase-bubble-done"}`.trim()}
      onClick={() => setExpanded((v) => !v)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpanded((v) => !v);
        }
      }}
    >
      {!isRunning && (
        <button
          className="phase-dismiss-btn"
          title="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            setDismissed(true);
            onDismiss?.();
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
      <div className="phase-bubble-header">
        {isRunning ? (
          <PhaseTicker phase={currentPhase} />
        ) : (
          <div className="phase-summary">
            <span className="phase-summary-icon" aria-hidden="true" />
            <span className="phase-summary-label">
              Done — {history.length} {history.length === 1 ? "step" : "steps"} in {formatDuration(totalDuration)}
            </span>
          </div>
        )}
        {history.length > 0 && (
          <span className="phase-chevron" aria-hidden="true">
            ▾
          </span>
        )}
      </div>
      <div className="phase-history">
        {history.length === 0 ? (
          <div className="phase-history-empty">No past steps yet…</div>
        ) : (
          history.map((h, i) => (
            <div
              key={`${i}-${h.phase.type}-${h.phase.label}`}
              className={`phase-history-item phase-${h.phase.type}`}
              style={{ animationDelay: `${i * 0.03}s` }}
            >
              <span className="phase-history-icon" aria-hidden="true" />
              <span className="phase-history-label">{h.phase.label}</span>
              <span className="phase-history-time">
                {formatDuration(h.duration)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
