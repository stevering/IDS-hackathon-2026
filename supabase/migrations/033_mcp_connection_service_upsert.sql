-- ═══════════════════════════════════════════════════════════════════════════
-- 033 — upsert_mcp_connection_service (service-role variant)
--
-- Allows the Temporal worker (running with service_role) to update MCP tokens
-- after performing an OAuth refresh_token exchange. The existing
-- upsert_mcp_connection (migration 024) uses auth.uid() and is restricted
-- to authenticated users, which doesn't fit the worker context.
--
-- Pattern: same body as the authenticated version, but takes p_user_id
-- explicitly and is GRANTed only to service_role.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.upsert_mcp_connection_service(
  p_user_id     UUID,
  p_server_id   TEXT,
  p_tokens_json TEXT,
  p_scopes      TEXT        DEFAULT NULL,
  p_expires_at  TIMESTAMPTZ DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vault_id UUID;
  v_existing UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  SELECT vault_id INTO v_existing
  FROM public.user_mcp_connections
  WHERE user_id = p_user_id AND server_id = p_server_id;

  IF v_existing IS NOT NULL THEN
    -- Update existing Vault secret in place (the vault_id is preserved)
    PERFORM vault.update_secret(v_existing, p_tokens_json);
    UPDATE public.user_mcp_connections
      SET scopes     = COALESCE(p_scopes, scopes),
          expires_at = p_expires_at,
          updated_at = now()
      WHERE user_id = p_user_id AND server_id = p_server_id;
  ELSE
    -- Create a new Vault secret
    v_vault_id := vault.create_secret(
      p_tokens_json,
      'mcp_' || p_server_id || '_' || p_user_id::text
    );
    INSERT INTO public.user_mcp_connections (user_id, server_id, vault_id, scopes, expires_at)
      VALUES (p_user_id, p_server_id, v_vault_id, p_scopes, p_expires_at);
  END IF;
END; $$;

-- Service role only — do not expose to authenticated users
REVOKE ALL ON FUNCTION public.upsert_mcp_connection_service(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_mcp_connection_service(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_mcp_connection_service(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
