"use client";

/**
 * useGuardianPhase — derives the current "thinking" phase and a short
 * history of past phases from the Temporal chat workflow state.
 *
 * Phase mapping:
 *   status === "tool_executing"                           → "tool"    (label: "Running: <toolName>")
 *   status === "streaming" + last part is reasoning/stream → "reason"  (label: "Thinking…")
 *   status === "streaming" + last part is text/streaming   → "write"   (label: "Writing response…")
 *   status === "streaming" + anything else                 → "prepare" (label: "Preparing context…")
 *   status === "idle" / "error"                            → null      (no phase)
 *
 * History: every time the derived phase type or label changes, the
 * previous phase is pushed into the history array with its elapsed
 * duration (capped at the 8 most recent steps). History is cleared at
 * the start of a new run so it doesn't accumulate across messages.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Phase, PhaseHistoryEntry, PhaseType } from "./PhaseBubble";

type ChatWorkflowStatus = "idle" | "streaming" | "tool_executing" | "error";

type ChatMessageLike = {
  role: "user" | "assistant" | "system";
  parts: Array<{
    type: string;
    state?: string;
    toolName?: string;
    [key: string]: unknown;
  }>;
};

/** Map workflow phase broadcast to a human-readable label. */
function labelForWorkflowPhase(phase: string): string {
  switch (phase) {
    case "loading_history": return "Loading conversation…";
    case "discovering_tools": return "Discovering tools…";
    case "connecting_figma": return "Connecting to Figma…";
    case "waiting_for_model": return "Waiting for model…";
    default: return "Preparing context…";
  }
}

function labelFor(type: PhaseType, toolName: string | null | undefined): string {
  switch (type) {
    case "prepare":
      return "Preparing context…";
    case "reason":
      return "Thinking…";
    case "tool":
      return `Running: ${toolName ?? "tool"}`;
    case "write":
      return "Writing response…";
  }
}

export function useGuardianPhase(
  status: ChatWorkflowStatus,
  messages: ChatMessageLike[],
  workflowPhase?: string | null,
  conversationId?: string | null,
): { currentPhase: Phase | null; history: PhaseHistoryEntry[] } {
  // Extract the signals from the messages array. useMemo keeps this cheap
  // to recompute — the object is re-created on every render but the
  // primitives destructured out are what feed useEffect's dependency array,
  // so the effect only fires when they actually change value.
  const signals = useMemo(() => {
    const lastMsg = messages[messages.length - 1];
    const lastPart = lastMsg?.parts[lastMsg.parts.length - 1];

    const lastPartType = lastPart?.type;
    const lastPartState = lastPart?.state;
    // Check if the last text part has actual content (not just a placeholder)
    const lastPartHasContent = lastPart?.type === "text" && typeof lastPart.text === "string" && lastPart.text.length > 0;

    let currentToolName: string | null = null;
    if (status === "tool_executing") {
      // Walk messages backward to find the most recent dynamic-tool part
      // whose state is "running" — that is the one currently executing.
      outer: for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        for (let j = m.parts.length - 1; j >= 0; j--) {
          const p = m.parts[j];
          if (p.type === "dynamic-tool" && p.state === "running") {
            currentToolName = (p.toolName as string | undefined) ?? null;
            break outer;
          }
        }
      }
    }

    return { lastPartType, lastPartState, lastPartHasContent, currentToolName };
  }, [messages, status]);

  const { lastPartType, lastPartState, lastPartHasContent, currentToolName } = signals;

  const [currentPhase, setCurrentPhase] = useState<Phase | null>(null);
  const [history, setHistory] = useState<PhaseHistoryEntry[]>([]);
  const phaseStartRef = useRef<{
    type: PhaseType;
    label: string;
    startedAt: number;
  } | null>(null);
  const wasRunningRef = useRef(false);

  // Reset all phase state when switching conversations.
  useEffect(() => {
    setCurrentPhase(null);
    setHistory([]);
    phaseStartRef.current = null;
    wasRunningRef.current = false;
  }, [conversationId]);

  useEffect(() => {
    // Map the current workflow state to a phase type.
    let nextType: PhaseType | null = null;
    if (status === "tool_executing") {
      nextType = "tool";
    } else if (status === "streaming") {
      if (lastPartType === "reasoning" && lastPartState === "streaming") {
        nextType = "reason";
      } else if (lastPartType === "text" && lastPartState === "streaming" && lastPartHasContent) {
        // Only show "Writing response" when actual text has arrived,
        // not for the empty placeholder added at stream start.
        nextType = "write";
      } else {
        nextType = "prepare";
      }
    }

    const running = nextType !== null;
    const justStarted = running && !wasRunningRef.current;
    wasRunningRef.current = running;

    // New run — clear history from the previous one.
    if (justStarted) {
      setHistory([]);
      phaseStartRef.current = null;
    }

    const prev = phaseStartRef.current;

    if (nextType === null) {
      // Workflow ended — flush the last active phase into history.
      if (prev) {
        const duration = Date.now() - prev.startedAt;
        setHistory((h) =>
          [
            ...h,
            {
              phase: { type: prev.type, label: prev.label },
              duration,
            },
          ].slice(-8),
        );
        phaseStartRef.current = null;
      }
      setCurrentPhase(null);
      return;
    }

    // When in "prepare" phase and we have a specific workflow phase, use its label
    const nextLabel = nextType === "prepare" && workflowPhase
      ? labelForWorkflowPhase(workflowPhase)
      : labelFor(nextType, currentToolName);

    if (!prev || prev.type !== nextType || prev.label !== nextLabel) {
      // Phase changed — push the previous one into history (unless we
      // just started, in which case there is nothing to record yet).
      if (prev && !justStarted) {
        const duration = Date.now() - prev.startedAt;
        setHistory((h) =>
          [
            ...h,
            {
              phase: { type: prev.type, label: prev.label },
              duration,
            },
          ].slice(-8),
        );
      }
      phaseStartRef.current = {
        type: nextType,
        label: nextLabel,
        startedAt: Date.now(),
      };
      setCurrentPhase({ type: nextType, label: nextLabel });
    }
  }, [status, lastPartType, lastPartState, lastPartHasContent, currentToolName, workflowPhase]);

  return { currentPhase, history };
}
