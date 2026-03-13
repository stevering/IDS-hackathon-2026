/**
 * useOrchestrationStream — SSE consumer for Temporal orchestration events.
 *
 * Connects to /api/orchestration/[id]/stream and maintains local state
 * from the event stream. This replaces the Supabase RT event forwarding.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  OrchestrationSSEEvent,
  AgentViewState,
} from "@guardian/orchestrations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrchestrationStreamState = {
  /** Whether the SSE connection is active */
  connected: boolean;
  /** Current agent states */
  agents: AgentViewState[];
  /** Event log (append-only) */
  events: OrchestrationSSEEvent[];
  /** Timer remaining in ms */
  timerRemainingMs: number | null;
  /** Total orchestration duration */
  totalDurationMs: number;
  /** Orchestration completion status */
  completedStatus: "completed" | "cancelled" | "timed_out" | null;
  /** Connection error */
  error: string | null;
};

const INITIAL_STATE: OrchestrationStreamState = {
  connected: false,
  agents: [],
  events: [],
  timerRemainingMs: null,
  totalDurationMs: 600_000,
  completedStatus: null,
  error: null,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useOrchestrationStream(workflowId: string | null) {
  const [state, setState] = useState<OrchestrationStreamState>(INITIAL_STATE);

  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!workflowId) {
      setState(INITIAL_STATE);
      return;
    }

    // Reset state for new workflow
    setState({ ...INITIAL_STATE });

    const es = new EventSource(`/api/orchestration/${workflowId}/stream`);
    eventSourceRef.current = es;

    es.onopen = () => {
      setState((prev) => ({ ...prev, connected: true, error: null }));
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;

        setState((prev) => {
          const next = { ...prev };

          switch (data.type as string) {
            case "connected":
              next.connected = true;
              return next; // Not a real event, skip appending

            case "orchestration_started":
              if ("agents" in data) {
                next.agents = (data as { agents: AgentViewState[] }).agents;
              }
              break;

            case "agent_status_changed":
              if ("agentShortId" in data && "status" in data) {
                const d = data as { agentShortId: string; status: AgentViewState["status"] };
                next.agents = prev.agents.map((a) =>
                  a.shortId === d.agentShortId ? { ...a, status: d.status } : a
                );
              }
              break;

            case "agent_report":
              if ("agentShortId" in data && "report" in data) {
                const d = data as { agentShortId: string; report: AgentViewState["lastReport"] };
                next.agents = prev.agents.map((a) =>
                  a.shortId === d.agentShortId ? { ...a, lastReport: d.report } : a
                );
              }
              break;

            case "timer_tick":
              if ("remainingMs" in data && "totalMs" in data) {
                const d = data as { remainingMs: number; totalMs: number };
                next.timerRemainingMs = d.remainingMs;
                next.totalDurationMs = d.totalMs;
              }
              break;

            case "orchestration_completed":
              if ("status" in data) {
                const d = data as { status: "completed" | "cancelled" | "timed_out" };
                next.completedStatus = d.status;
                next.connected = false;
              }
              // Close EventSource — prevent auto-reconnect loop
              es.close();
              break;

            case "error":
              if ("message" in data) {
                next.error = (data as { message: string }).message;
              }
              break;

            default:
              break;
          }

          // Append all events to the log
          next.events = [...prev.events, data as OrchestrationSSEEvent];

          return next;
        });
      } catch {
        // Ignore parse errors (e.g. keepalive comments)
      }
    };

    es.onerror = () => {
      setState((prev) => ({
        ...prev,
        connected: false,
        error: prev.completedStatus ? null : "SSE connection lost",
      }));
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [workflowId]);

  const disconnect = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setState(INITIAL_STATE);
  }, []);

  return { ...state, disconnect };
}
