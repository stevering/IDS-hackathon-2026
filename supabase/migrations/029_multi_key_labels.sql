-- Migration: allow multiple keys per provider + labels + key hints
--
-- 1. Drop unique constraint (user_id, provider) to allow multiple keys per provider
-- 2. Add label TEXT (user-friendly name, e.g. "vercel-1")
-- 3. Add key_hint TEXT (first 3 + last 3 chars for identification, e.g. "vck...x9f")

-- 1. Drop unique constraint
ALTER TABLE public.user_api_keys DROP CONSTRAINT IF EXISTS user_api_keys_user_id_provider_key;

-- 2. Add new columns
ALTER TABLE public.user_api_keys ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE public.user_api_keys ADD COLUMN IF NOT EXISTS key_hint TEXT;

-- 3. Backfill labels for existing keys (e.g. "gateway-1", "openai-1")
UPDATE public.user_api_keys SET label = provider || '-1' WHERE label IS NULL;

-- 4. Replace upsert_api_key with insert_api_key (no more upsert since multiple keys per provider)
DROP FUNCTION IF EXISTS public.upsert_api_key(TEXT, TEXT, TEXT);

CREATE FUNCTION public.insert_api_key(
  p_provider      TEXT,
  p_secret        TEXT,
  p_label         TEXT DEFAULT NULL,
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
  v_label     TEXT;
  v_hint      TEXT;
  v_count     INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Generate key hint: first 3 + last 3 chars
  IF length(p_secret) >= 6 THEN
    v_hint := left(p_secret, 3) || '...' || right(p_secret, 3);
  ELSE
    v_hint := '***';
  END IF;

  -- Generate default label if not provided: provider-N
  IF p_label IS NOT NULL AND p_label <> '' THEN
    v_label := p_label;
  ELSE
    DECLARE v_prefix TEXT;
    BEGIN
      v_prefix := CASE p_provider WHEN 'gateway' THEN 'vercel-gateway' ELSE p_provider END;
      SELECT coalesce(max(
        CASE WHEN label ~ ('^' || v_prefix || '-[0-9]+$')
          THEN (regexp_replace(label, '^.*-', ''))::INT
          ELSE 0
        END
      ), 0) INTO v_count
      FROM user_api_keys
      WHERE user_id = v_user_id AND provider = p_provider;
      v_label := v_prefix || '-' || (v_count + 1)::TEXT;
    END;
  END IF;

  -- Store secret in vault
  INSERT INTO vault.secrets (secret) VALUES (p_secret) RETURNING id INTO v_vault_id;

  -- Create key record
  INSERT INTO user_api_keys (user_id, provider, vault_id, label, key_hint, default_model)
  VALUES (v_user_id, p_provider, v_vault_id, v_label, v_hint, p_default_model)
  RETURNING id INTO v_key_id;

  -- If this is the user's first key, make it default
  IF (SELECT count(*) FROM user_api_keys WHERE user_id = v_user_id) = 1 THEN
    UPDATE user_api_keys SET is_default = true WHERE id = v_key_id;
  END IF;

  RETURN v_key_id;
END;
$$;

-- 5. Update key (secret and/or label) by ID
CREATE OR REPLACE FUNCTION public.update_api_key(
  p_key_id        UUID,
  p_secret        TEXT DEFAULT NULL,
  p_label         TEXT DEFAULT NULL,
  p_default_model TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   UUID := auth.uid();
  v_vault_id  UUID;
  v_old_vault UUID;
  v_hint      TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Verify ownership
  SELECT vault_id INTO v_old_vault
  FROM user_api_keys
  WHERE id = p_key_id AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Key not found';
  END IF;

  -- Update secret if provided
  IF p_secret IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_old_vault;
    INSERT INTO vault.secrets (secret) VALUES (p_secret) RETURNING id INTO v_vault_id;

    -- Generate key hint
    IF length(p_secret) >= 6 THEN
      v_hint := left(p_secret, 3) || '...' || right(p_secret, 3);
    ELSE
      v_hint := '***';
    END IF;

    UPDATE user_api_keys
    SET vault_id = v_vault_id, key_hint = v_hint, updated_at = now()
    WHERE id = p_key_id;
  END IF;

  -- Update label if provided
  IF p_label IS NOT NULL THEN
    UPDATE user_api_keys SET label = p_label, updated_at = now() WHERE id = p_key_id;
  END IF;

  -- Update default_model if provided
  IF p_default_model IS NOT NULL THEN
    UPDATE user_api_keys SET default_model = p_default_model, updated_at = now() WHERE id = p_key_id;
  END IF;
END;
$$;

-- 6. Delete by key ID instead of provider
DROP FUNCTION IF EXISTS public.delete_api_key(TEXT);

CREATE FUNCTION public.delete_api_key(p_key_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   UUID := auth.uid();
  v_vault_id  UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT vault_id INTO v_vault_id
  FROM user_api_keys
  WHERE id = p_key_id AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Key not found';
  END IF;

  DELETE FROM vault.secrets WHERE id = v_vault_id;
  DELETE FROM user_api_keys WHERE id = p_key_id AND user_id = v_user_id;
END;
$$;

-- 7. Set default by key ID instead of provider
DROP FUNCTION IF EXISTS public.set_default_api_key(TEXT);

CREATE FUNCTION public.set_default_api_key(p_key_id UUID)
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

  -- Verify ownership
  IF NOT EXISTS (SELECT 1 FROM user_api_keys WHERE id = p_key_id AND user_id = v_user_id) THEN
    RAISE EXCEPTION 'Key not found';
  END IF;

  -- Clear all defaults for this user
  UPDATE user_api_keys SET is_default = false WHERE user_id = v_user_id;
  -- Set new default
  UPDATE user_api_keys SET is_default = true WHERE id = p_key_id;
END;
$$;

-- 8. Update key default model by key ID (replaces the provider-based one)
DROP FUNCTION IF EXISTS public.update_key_default_model(TEXT, TEXT);

CREATE FUNCTION public.update_key_default_model(
  p_key_id        UUID,
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
  WHERE id = p_key_id AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Key not found';
  END IF;
END;
$$;

-- 9. get_api_key stays provider-based (for model resolver compat)
-- It returns the secret of the DEFAULT key if it matches the provider,
-- otherwise the first key of that provider.
DROP FUNCTION IF EXISTS public.get_api_key(TEXT);

CREATE FUNCTION public.get_api_key(p_provider TEXT)
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
  -- Try the default key first if it matches the provider
  SELECT k.vault_id INTO v_vault_id
  FROM user_api_keys k
  WHERE k.user_id = v_user_id AND k.provider = p_provider AND k.is_default = true
  LIMIT 1;

  -- Fallback: any key of that provider
  IF v_vault_id IS NULL THEN
    SELECT k.vault_id INTO v_vault_id
    FROM user_api_keys k
    WHERE k.user_id = v_user_id AND k.provider = p_provider
    ORDER BY k.created_at ASC
    LIMIT 1;
  END IF;

  IF v_vault_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ds.decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets ds
  WHERE ds.id = v_vault_id;

  RETURN v_secret;
END;
$$;

-- 10. Same for service-role variant
DROP FUNCTION IF EXISTS public.get_api_key_for_user(UUID, TEXT);

CREATE FUNCTION public.get_api_key_for_user(p_user_id UUID, p_provider TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret   TEXT;
  v_vault_id UUID;
BEGIN
  SELECT k.vault_id INTO v_vault_id
  FROM user_api_keys k
  WHERE k.user_id = p_user_id AND k.provider = p_provider AND k.is_default = true
  LIMIT 1;

  IF v_vault_id IS NULL THEN
    SELECT k.vault_id INTO v_vault_id
    FROM user_api_keys k
    WHERE k.user_id = p_user_id AND k.provider = p_provider
    ORDER BY k.created_at ASC
    LIMIT 1;
  END IF;

  IF v_vault_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ds.decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets ds
  WHERE ds.id = v_vault_id;

  RETURN v_secret;
END;
$$;
