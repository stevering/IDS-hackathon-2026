-- Account deletion support:
-- 1. Fix intercept_queue FK to cascade on user deletion
-- 2. Create RPC to clean up vault secrets before cascade delete

-- Fix: intercept_queue user_id missing ON DELETE CASCADE
ALTER TABLE intercept_queue
  DROP CONSTRAINT IF EXISTS intercept_queue_user_id_fkey,
  ADD CONSTRAINT intercept_queue_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- RPC: clean up vault secrets owned by a user (must run BEFORE auth.users delete)
-- SECURITY DEFINER so it can access vault.secrets (owned by supabase_admin)
CREATE OR REPLACE FUNCTION public.cleanup_user_vault_secrets(p_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Delete vault secrets for API keys
  DELETE FROM vault.secrets WHERE id IN (
    SELECT vault_id FROM public.user_api_keys WHERE user_id = p_user_id
  );

  -- Delete vault secrets for MCP connections
  DELETE FROM vault.secrets WHERE id IN (
    SELECT vault_id FROM public.user_mcp_connections WHERE user_id = p_user_id
  );
END;
$$;

-- Only service_role can call this (account deletion is admin-level)
REVOKE ALL ON FUNCTION public.cleanup_user_vault_secrets(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_user_vault_secrets(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_user_vault_secrets(UUID) TO service_role;
