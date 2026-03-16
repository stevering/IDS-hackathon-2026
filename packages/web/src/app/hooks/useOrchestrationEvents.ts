"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fetches persisted orchestration events from the DB for a given workflowId.
 * Used to replay events of completed (or in-progress after refresh) collabs.
 */
export function useOrchestrationEvents(workflowId: string | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef<string | null>(null);

  const fetchEvents = useCallback(async (wfId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/orchestration/${encodeURIComponent(wfId)}/events`);
      if (!res.ok) return;
      const { events: dbEvents } = await res.json();
      // Convert DB rows back to SSE event shape
      setEvents((dbEvents ?? []).map((row: { payload: unknown }) => row.payload));
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!workflowId || workflowId === fetchedRef.current) return;
    fetchedRef.current = workflowId;
    fetchEvents(workflowId);
  }, [workflowId, fetchEvents]);

  // Reset when workflowId changes to null
  useEffect(() => {
    if (!workflowId) {
      setEvents([]);
      fetchedRef.current = null;
    }
  }, [workflowId]);

  return { events, loading };
}
