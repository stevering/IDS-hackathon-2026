-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 003 — Fix delete_api_key: vault.delete_secret() does not exist
-- vault.delete_secret(uuid) is not a public Supabase Vault API.
-- The correct way is to DELETE directly from vault.secrets.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.delete_api_key(p_provider TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_vault_id    UUID;
  v_was_default BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT vault_id, is_default INTO v_vault_id, v_was_default
  FROM public.user_api_keys
  WHERE user_id = v_user_id AND provider = p_provider;

  IF v_vault_id IS NOT NULL THEN
    -- Remove the row first (FK constraint is on user_api_keys, not vault.secrets)
    DELETE FROM public.user_api_keys
      WHERE user_id = v_user_id AND provider = p_provider;

    -- Delete the encrypted secret from Vault directly
    -- vault.delete_secret(uuid) does not exist — use the table directly
    DELETE FROM vault.secrets WHERE id = v_vault_id;

    -- Promote the oldest remaining key as default if we deleted the default
    IF v_was_default THEN
      UPDATE public.user_api_keys SET is_default = TRUE
        WHERE user_id = v_user_id AND id = (
          SELECT id FROM public.user_api_keys
          WHERE user_id = v_user_id
          ORDER BY created_at ASC LIMIT 1
        );
    END IF;
  END IF;
END; $$;
