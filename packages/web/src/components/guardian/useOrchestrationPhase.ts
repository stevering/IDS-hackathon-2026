import { useRef, useMemo } from "react";
import type { Phase, PhaseHistoryEntry } from "./PhaseBubble";
import type { OrchestrationSSEEvent } from "@guardian/orchestrations";

export function useOrchestrationPhase(
  events: OrchestrationSSEEvent[],
  completedStatus: string | null
): { currentPhase: Phase | null; history: PhaseHistoryEntry[] } {
  const lastEventIdxRef = useRef(0);
  const historyRef = useRef<PhaseHistoryEntry[]>([]);
  const phaseStartRef = useRef<number>(Date.now());
  const lastPhaseRef = useRef<Phase | null>(null);

  return useMemo(() => {
    const newEvents = events.slice(lastEventIdxRef.current);
    lastEventIdxRef.current = events.length;

    for (const e of newEvents) {
      let phase: Phase | null = null;

      switch (e.type) {
        case "orchestrator_reasoning":
          phase = { type: "reason", label: "Orchestrator reasoning..." };
          break;
        case "orchestrator_tool_call":
          if (e.toolName === "send_agent_directive") {
            const agentId = (e.args as { agentShortId?: string }).agentShortId ?? "agent";
            phase = { type: "tool", label: `Directing ${agentId}` };
          } else if (e.toolName === "mark_agent_done") {
            phase = { type: "tool", label: "Marking agent done" };
          } else {
            phase = { type: "tool", label: e.toolName };
          }
          break;
        case "orchestrator_text":
          phase = { type: "write", label: "Orchestrator responding" };
          break;
        case "agent_activity": {
          const last = e.activities[e.activities.length - 1];
          if (last?.action === "tool_call") {
            phase = { type: "tool", label: `${e.agentShortId}: ${last.toolName}` };
          } else if (last?.action === "reasoning") {
            phase = { type: "reason", label: `${e.agentShortId} reasoning...` };
          } else if (last?.action === "code_executed") {
            phase = { type: "tool", label: `${e.agentShortId}: code ${last.success ? "✓" : "✗"}` };
          }
          break;
        }
        case "agent_status_changed":
          if (e.status === "completed") {
            phase = { type: "write", label: `${e.agentShortId} completed` };
          }
          break;
      }

      if (phase && lastPhaseRef.current) {
        const duration = Date.now() - phaseStartRef.current;
        historyRef.current = [...historyRef.current, { phase: lastPhaseRef.current, duration }];
      }
      if (phase) {
        lastPhaseRef.current = phase;
        phaseStartRef.current = Date.now();
      }
    }

    if (completedStatus) {
      if (lastPhaseRef.current) {
        const duration = Date.now() - phaseStartRef.current;
        historyRef.current = [...historyRef.current, { phase: lastPhaseRef.current, duration }];
        lastPhaseRef.current = null;
      }
      return { currentPhase: null, history: historyRef.current };
    }

    return { currentPhase: lastPhaseRef.current, history: historyRef.current };
  }, [events, completedStatus]);
}
