"use client";

/**
 * PhaseBubble — small "thinking" bubble attached below the last chat
 * message while the LLM is working. Shows the current phase with a
 * stacked-ticker animation (the previous label slides up & fades out,
 * the new one slides in from below). Click to expand an accordion with
 * the history of all past phases in the current run and their timings.
 *
 * Designed to replace the legacy 3-dot ThinkingIndicator. See
 * useGuardianPhase.ts for how the current phase + history are derived
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

export function PhaseBubble({ currentPhase, history }: PhaseBubbleProps) {
  const [expanded, setExpanded] = useState(false);

  if (!currentPhase && history.length === 0) return null;

  return (
    <div
      className={`phase-bubble ${expanded ? "expanded" : ""}`.trim()}
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
      <div className="phase-bubble-header">
        <PhaseTicker phase={currentPhase} />
        <span className="phase-chevron" aria-hidden="true">
          ▾
        </span>
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
