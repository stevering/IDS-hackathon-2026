-- Migration: add get_api_key_by_id RPC
--
-- get_api_key(provider) returns the default key for a provider.
-- When we know the specific key ID (e.g., provider-models catalog, chat with keyId),
-- we need to fetch THAT key's secret, not the default one.

CREATE OR REPLACE FUNCTION public.get_api_key_by_id(p_key_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_secret   TEXT;
  v_vault_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT k.vault_id INTO v_vault_id
  FROM user_api_keys k
  WHERE k.id = p_key_id AND k.user_id = v_user_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT ds.decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets ds
  WHERE ds.id = v_vault_id;

  RETURN v_secret;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_api_key_by_id(UUID) TO authenticated;
