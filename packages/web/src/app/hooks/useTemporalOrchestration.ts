/**
 * useTemporalOrchestration — Temporal-backed orchestration hook.
 *
 * Replaces the Supabase RT state machine with Temporal API calls + SSE.
 * This is the new orchestration hook that works with the Temporal backend.
 *
 * Activated when NEXT_PUBLIC_TEMPORAL_ENABLED=true.
 */

"use client";

import { useState, useCallback, useRef } from "react";
import { useOrchestrationStream } from "./useOrchestrationStream";
import type { AgentId } from "@guardian/orchestrations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TemporalOrchestrationState = {
  /** Active workflow ID set by startOrchestration (null when idle) */
  workflowId: string | null;
  /** Whether we're starting an orchestration */
  starting: boolean;
  /** Error from the last operation */
  error: string | null;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * @param externalWorkflowId — optional workflowId derived from the active
 *   conversation's metadata. When set, the stream connects to this workflow
 *   even if no orchestration was started in this session (e.g. page reload,
 *   sidebar navigation). The internal workflowId from startOrchestration
 *   takes priority when set.
 */
export function useTemporalOrchestration(externalWorkflowId?: string | null) {
  const [state, setState] = useState<TemporalOrchestrationState>({
    workflowId: null,
    starting: false,
    error: null,
  });

  // Effective workflowId: internal (from startOrchestration) wins, else external
  const effectiveWorkflowId = state.workflowId ?? externalWorkflowId ?? null;

  // SSE stream consumer — driven by effectiveWorkflowId
  const stream = useOrchestrationStream(effectiveWorkflowId);

  // Keep a ref for callbacks that need the current effectiveWorkflowId
  const effectiveWfIdRef = useRef(effectiveWorkflowId);
  effectiveWfIdRef.current = effectiveWorkflowId;

  // ── Start orchestration ────────────────────────────────────────────────
  const startOrchestration = useCallback(
    async (params: {
      task: string;
      targetAgents: AgentId[];
      model?: string;
      maxDurationMs?: number;
      context?: Record<string, unknown>;
      /**
       * Existing conversation to attach the orchestration to. When set, the
       * server skips creating a parent conv and links the new sub-conv as a
       * child of this one (preserves the chat history → collab thread).
       * When omitted, the server creates a standalone parent (MCP-style).
       */
      conversationId?: string;
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
      const wfId = effectiveWfIdRef.current;
      if (!wfId) return;

      try {
        await fetch(`/api/orchestration/${wfId}/signal`, {
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
    []
  );

  // ── Stop orchestration ─────────────────────────────────────────────────
  const stopOrchestration = useCallback(async () => {
    const wfId = effectiveWfIdRef.current;
    if (!wfId) return;

    try {
      await fetch(`/api/orchestration/${wfId}/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal: "stop" }),
      });
    } catch (err) {
      console.error("[useTemporalOrchestration] stop failed:", err);
    }
  }, []);

  // ── Reset (after completion) ───────────────────────────────────────────
  const reset = useCallback(() => {
    stream.disconnect();
    setState({ workflowId: null, starting: false, error: null });
  }, [stream]);

  return {
    // State
    workflowId: effectiveWorkflowId,
    /**
     * The workflowId that was started by `startOrchestration` in this session
     * (i.e. user-initiated from this tab — not picked up via externalWorkflowId
     * or live discovery). Consumers can use this to gate behaviors that should
     * only fire on user-initiated runs (e.g. auto-switching to the orch sub-conv).
     */
    userInitiatedWorkflowId: state.workflowId,
    starting: state.starting,
    error: state.error,
    isActive: effectiveWorkflowId !== null && !stream.completedStatus,

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
