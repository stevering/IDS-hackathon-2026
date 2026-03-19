-- Add durable flag to orchestration_events.
-- Durable events survive the 7-day TTL cleanup (briefs, directives, reports, start/completed).
-- Ephemeral events (thinking, activity, status_changed) are cleaned up as before.

ALTER TABLE public.orchestration_events
  ADD COLUMN IF NOT EXISTS durable BOOLEAN NOT NULL DEFAULT false;

-- Update cleanup to only delete non-durable events
CREATE OR REPLACE FUNCTION public.cleanup_old_orchestration_events()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.orchestration_events oe
  WHERE oe.durable = false
    AND oe.created_at < now() - INTERVAL '7 days'
    AND NOT EXISTS (
      SELECT 1 FROM public.orchestration_events active
      WHERE active.workflow_id = oe.workflow_id
        AND active.event_type IN ('orchestration_started')
        AND active.created_at > now() - INTERVAL '7 days'
    );
END;
$$;
