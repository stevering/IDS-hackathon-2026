-- Fix 1: orchestrations.id must be TEXT (engine generates "orch-xxx" strings, not UUIDs)
-- Drop ALL dependent FKs first, change type, recreate FKs.
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_orchestration_id_fkey;
ALTER TABLE public.user_clients DROP CONSTRAINT IF EXISTS user_clients_orchestration_id_fkey;

ALTER TABLE public.orchestrations ALTER COLUMN id SET DATA TYPE TEXT USING id::TEXT;
ALTER TABLE public.conversations ALTER COLUMN orchestration_id SET DATA TYPE TEXT USING orchestration_id::TEXT;
ALTER TABLE public.user_clients ALTER COLUMN orchestration_id SET DATA TYPE TEXT USING orchestration_id::TEXT;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_orchestration_id_fkey
  FOREIGN KEY (orchestration_id) REFERENCES public.orchestrations(id) ON DELETE SET NULL;

ALTER TABLE public.user_clients
  ADD CONSTRAINT user_clients_orchestration_id_fkey
  FOREIGN KEY (orchestration_id) REFERENCES public.orchestrations(id) ON DELETE SET NULL;

-- Fix 2: debug_traces needs optional workflow_id for multi-client orchestration traces
ALTER TABLE public.debug_traces ADD COLUMN IF NOT EXISTS workflow_id TEXT;
CREATE INDEX IF NOT EXISTS idx_debug_traces_workflow ON public.debug_traces (workflow_id) WHERE workflow_id IS NOT NULL;

-- Allow multiple clients per workflow (unique on workflow_id + source_client_id when workflow_id is set)
-- The existing unique(conversation_id, source_client_id) stays for classic conversations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_debug_traces_workflow_client
  ON public.debug_traces (workflow_id, source_client_id) WHERE workflow_id IS NOT NULL;
