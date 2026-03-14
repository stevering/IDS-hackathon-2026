-- Align orchestrations table with what the Temporal persistence activity actually writes.
-- The workflow calls saveOrchestrationState with: orchestrationId, status, agentResults,
-- durationMs, userId — but NOT orchestrator_client_id or conversation_id.

-- 1. Make orchestrator_client_id and conversation_id nullable (workflow doesn't have them)
ALTER TABLE public.orchestrations ALTER COLUMN orchestrator_client_id DROP NOT NULL;
ALTER TABLE public.orchestrations ALTER COLUMN conversation_id DROP NOT NULL;

-- 2. Add columns that the activity writes but the table doesn't have
ALTER TABLE public.orchestrations ADD COLUMN IF NOT EXISTS agent_results JSONB DEFAULT '{}';
ALTER TABLE public.orchestrations ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE public.orchestrations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
