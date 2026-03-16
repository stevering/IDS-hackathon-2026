-- Persistent storage for orchestration SSE events
-- Events are auto-cleaned after 7 days for completed collabs

CREATE TABLE IF NOT EXISTS public.orchestration_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id TEXT        NOT NULL,
  event_type  TEXT        NOT NULL,
  agent_id    TEXT,
  payload     JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orch_events_workflow ON public.orchestration_events (workflow_id, created_at ASC);

-- RLS: user can see events for their own orchestrations
ALTER TABLE public.orchestration_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own orchestration events"
  ON public.orchestration_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.metadata->>'workflowId' = orchestration_events.workflow_id
        AND c.user_id = auth.uid()
    )
  );

CREATE POLICY "Authenticated users can insert events"
  ON public.orchestration_events FOR INSERT
  WITH CHECK (true);

-- Auto-cleanup function: delete events from completed collabs older than 7 days
CREATE OR REPLACE FUNCTION public.cleanup_old_orchestration_events()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.orchestration_events oe
  WHERE oe.created_at < now() - INTERVAL '7 days'
    AND NOT EXISTS (
      SELECT 1 FROM public.orchestration_events active
      WHERE active.workflow_id = oe.workflow_id
        AND active.event_type IN ('orchestration_started')
        AND active.created_at > now() - INTERVAL '7 days'
    );
END;
$$;
