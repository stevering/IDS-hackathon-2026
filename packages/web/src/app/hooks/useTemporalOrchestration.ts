/**
 * useTemporalOrchestration — Temporal-backed orchestration hook.
 *
 * Replaces the Supabase RT state machine with Temporal API calls + SSE.
 * This is the new orchestration hook that works with the Temporal backend.
 *
 * Activated when NEXT_PUBLIC_TEMPORAL_ENABLED=true.
 */

"use client";

import { useState, useCallback } from "react";
import { useOrchestrationStream } from "./useOrchestrationStream";
import type { AgentId } from "@guardian/orchestrations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TemporalOrchestrationState = {
  /** Active workflow ID (null when idle) */
  workflowId: string | null;
  /** Whether we're starting an orchestration */
  starting: boolean;
  /** Error from the last operation */
  error: string | null;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTemporalOrchestration() {
  const [state, setState] = useState<TemporalOrchestrationState>({
    workflowId: null,
    starting: false,
    error: null,
  });

  // SSE stream consumer
  const stream = useOrchestrationStream(state.workflowId);

  // ── Start orchestration ────────────────────────────────────────────────
  const startOrchestration = useCallback(
    async (params: {
      task: string;
      targetAgents: AgentId[];
      model?: string;
      maxDurationMs?: number;
      context?: Record<string, unknown>;
    }) => {
      setState((prev) => ({ ...prev, starting: true, error: null }));

      try {
        const res = await fetch("/api/orchestration/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }

        const { workflowId } = await res.json();
        setState({ workflowId, starting: false, error: null });
        return workflowId as string;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, starting: false, error: msg }));
        return null;
      }
    },
    []
  );

  // ── Send user input ────────────────────────────────────────────────────
  const sendUserInput = useCallback(
    async (content: string, targetAgentId?: string) => {
      if (!state.workflowId) return;

      try {
        await fetch(`/api/orchestration/${state.workflowId}/signal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signal: "userInput",
            payload: { content, targetAgentId },
          }),
        });
      } catch (err) {
        console.error("[useTemporalOrchestration] sendUserInput failed:", err);
      }
    },
    [state.workflowId]
  );

  // ── Stop orchestration ─────────────────────────────────────────────────
  const stopOrchestration = useCallback(async () => {
    if (!state.workflowId) return;

    try {
      await fetch(`/api/orchestration/${state.workflowId}/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal: "stop" }),
      });
    } catch (err) {
      console.error("[useTemporalOrchestration] stop failed:", err);
    }
  }, [state.workflowId]);

  // ── Reset (after completion) ───────────────────────────────────────────
  const reset = useCallback(() => {
    stream.disconnect();
    setState({ workflowId: null, starting: false, error: null });
  }, [stream]);

  return {
    // State
    workflowId: state.workflowId,
    starting: state.starting,
    error: state.error,
    isActive: state.workflowId !== null && !stream.completedStatus,

    // Stream data
    agents: stream.agents,
    events: stream.events,
    timerRemainingMs: stream.timerRemainingMs,
    totalDurationMs: stream.totalDurationMs,
    completedStatus: stream.completedStatus,
    connected: stream.connected,
    streamError: stream.error,

    // Actions
    startOrchestration,
    sendUserInput,
    stopOrchestration,
    reset,
  };
}
