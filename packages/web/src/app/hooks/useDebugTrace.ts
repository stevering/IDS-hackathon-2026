"use client";

import { useCallback, useRef } from "react";
import type { PluginEvent } from "./useFigmaPlugin";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DebugTrace = {
  sourceClientId: string;
  sourceShortId: string | null;
  clientType: string | null;
  events: PluginEvent[];
  clientState: Record<string, unknown>;
  pushedAt: string;
};

export type UnifiedDebugReport = {
  conversationId: string;
  orchestrationId?: string;
  workflowId?: string;
  traces: DebugTrace[];
  temporalHistory?: {
    ts: string;
    type: string;
    detail?: Record<string, unknown>;
  }[];
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Generic debug trace hook.
 *
 * - Classic conversation: keyed by conversationId
 * - Orchestration: keyed by workflowId (shared across all clients)
 *
 * pushTrace(): POST current client's events to the API (upsert)
 * fetchUnifiedDebug(): GET merged traces from all clients + optional Temporal history
 *
 * Debounce: skips push if last push was <5s ago.
 */
export function useDebugTrace(
  conversationId: string | null,
  workflowId?: string | null
) {
  const lastPushRef = useRef(0);

  const pushTrace = useCallback(
    async (
      events: PluginEvent[],
      clientState: Record<string, unknown>,
      meta: {
        sourceClientId: string;
        sourceShortId?: string;
        clientType?: string;
      }
    ): Promise<boolean> => {
      if (!conversationId) return false;

      // Debounce: skip if last push was <5s ago
      const now = Date.now();
      if (now - lastPushRef.current < 5000) return false;
      lastPushRef.current = now;

      try {
        const res = await fetch(
          `/api/conversations/${conversationId}/debug-traces`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourceClientId: meta.sourceClientId,
              sourceShortId: meta.sourceShortId,
              clientType: meta.clientType,
              events,
              clientState,
              ...(workflowId ? { workflowId } : {}),
            }),
          }
        );
        return res.ok;
      } catch {
        return false;
      }
    },
    [conversationId, workflowId]
  );

  const fetchUnifiedDebug =
    useCallback(async (): Promise<UnifiedDebugReport | null> => {
      if (!conversationId) return null;

      try {
        const qs = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : "";
        const res = await fetch(
          `/api/conversations/${conversationId}/debug-traces${qs}`
        );
        if (!res.ok) return null;
        return (await res.json()) as UnifiedDebugReport;
      } catch {
        return null;
      }
    }, [conversationId, workflowId]);

  return { pushTrace, fetchUnifiedDebug };
}
