-- Expand the orchestrations.status CHECK constraint to include all terminal states.
-- Previously only 'active', 'completed', 'cancelled' were allowed.
ALTER TABLE orchestrations DROP CONSTRAINT IF EXISTS orchestrations_status_check;
ALTER TABLE orchestrations ADD CONSTRAINT orchestrations_status_check
  CHECK (status IN ('active', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'timed_out'));
