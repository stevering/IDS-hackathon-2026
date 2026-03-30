-- Migration: per-key default model + usage source preference
--
-- 1. Add default_model to user_api_keys (per-key model preference)
-- 2. Add usage_source to user_settings ('included' or 'byok')
-- 3. Migrate existing default_model from user_settings to the user's default key
-- 4. Users with a default key auto-switch to usage_source = 'byok'

-- 1. Per-key default model
ALTER TABLE public.user_api_keys
  ADD COLUMN IF NOT EXISTS default_model TEXT;

-- 2. Usage source preference
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS usage_source TEXT NOT NULL DEFAULT 'included';

-- 3. Migrate: copy user_settings.default_model → default key's default_model
UPDATE public.user_api_keys k
SET default_model = s.default_model
FROM public.user_settings s
WHERE k.user_id = s.user_id
  AND k.is_default = true
  AND s.default_model IS NOT NULL
  AND k.default_model IS NULL;

-- 4. Users who already have a default BYOK key → set usage_source = 'byok'
UPDATE public.user_settings s
SET usage_source = 'byok'
WHERE EXISTS (
  SELECT 1 FROM public.user_api_keys k
  WHERE k.user_id = s.user_id AND k.is_default = true
)
AND s.usage_source = 'included';

-- 5. Drop old upsert_api_key signature (2 params) before creating new one (3 params)
DROP FUNCTION IF EXISTS public.upsert_api_key(TEXT, TEXT);

-- 5b. Update upsert_api_key RPC to accept default_model
CREATE OR REPLACE FUNCTION public.upsert_api_key(
  p_provider   TEXT,
  p_secret     TEXT,
  p_default_model TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   UUID := auth.uid();
  v_vault_id  UUID;
  v_key_id    UUID;
  v_old_vault UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Check if key already exists for this provider
  SELECT id, vault_id INTO v_key_id, v_old_vault
  FROM user_api_keys
  WHERE user_id = v_user_id AND provider = p_provider;

  IF v_key_id IS NOT NULL THEN
    -- Update existing vault secret
    PERFORM vault.update_secret(v_old_vault, p_secret);
    -- Update key record
    UPDATE user_api_keys
    SET
        default_model = COALESCE(p_default_model, default_model),
        updated_at = now()
    WHERE id = v_key_id;
    RETURN v_key_id;
  ELSE
    -- Store secret in vault
    SELECT vault.create_secret(p_secret) INTO v_vault_id;
    -- Create key record
    INSERT INTO user_api_keys (user_id, provider, vault_id, default_model)
    VALUES (v_user_id, p_provider, v_vault_id, p_default_model)
    RETURNING id INTO v_key_id;
    RETURN v_key_id;
  END IF;
END;
$$;

-- 6. RPC to update a key's default model
CREATE OR REPLACE FUNCTION public.update_key_default_model(
  p_provider      TEXT,
  p_default_model TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE user_api_keys
  SET default_model = p_default_model, updated_at = now()
  WHERE user_id = v_user_id AND provider = p_provider;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Key not found for provider %', p_provider;
  END IF;
END;
$$;

-- 7. Drop old update_settings signature (8 params) before creating new one (9 params)
-- Otherwise PostgreSQL sees two overloads and cannot resolve the call.
DROP FUNCTION IF EXISTS public.update_settings(
  BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN
);

-- 7b. Update settings RPC to handle usage_source
CREATE OR REPLACE FUNCTION public.update_settings(
  p_auto_accept        BOOLEAN       DEFAULT NULL,
  p_default_model      TEXT          DEFAULT NULL,
  p_approval_mode      TEXT          DEFAULT NULL,
  p_guard_enabled      BOOLEAN       DEFAULT NULL,
  p_developer_mode     BOOLEAN       DEFAULT NULL,
  p_dev_show_all_events BOOLEAN      DEFAULT NULL,
  p_dev_llm_delegation  BOOLEAN      DEFAULT NULL,
  p_dev_slow_delegation BOOLEAN      DEFAULT NULL,
  p_usage_source       TEXT          DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  INSERT INTO user_settings (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE user_settings SET
    auto_accept        = COALESCE(p_auto_accept, auto_accept),
    default_model      = COALESCE(p_default_model, default_model),
    approval_mode      = COALESCE(p_approval_mode, approval_mode),
    guard_enabled      = COALESCE(p_guard_enabled, guard_enabled),
    developer_mode     = COALESCE(p_developer_mode, developer_mode),
    dev_show_all_events = COALESCE(p_dev_show_all_events, dev_show_all_events),
    dev_llm_delegation  = COALESCE(p_dev_llm_delegation, dev_llm_delegation),
    dev_slow_delegation = COALESCE(p_dev_slow_delegation, dev_slow_delegation),
    usage_source       = COALESCE(p_usage_source, usage_source),
    updated_at         = now()
  WHERE user_id = v_user_id;
END;
$$;
