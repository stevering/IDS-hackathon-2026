-- Service-role variant of get_api_key that accepts an explicit user_id.
-- Used by the Temporal worker (service-role client) which cannot use auth.uid().
-- The original get_api_key(p_provider) still works for browser clients via session auth.

CREATE OR REPLACE FUNCTION public.get_api_key_for_user(p_user_id UUID, p_provider TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vault_id UUID;
  v_secret   TEXT;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user_id is required'; END IF;
  SELECT vault_id INTO v_vault_id
  FROM public.user_api_keys
  WHERE user_id = p_user_id AND provider = p_provider;
  IF v_vault_id IS NULL THEN RETURN NULL; END IF;
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE id = v_vault_id;
  RETURN v_secret;
END; $$;
