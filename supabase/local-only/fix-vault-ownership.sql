-- ============================================================================
-- LOCAL DEV — Vault/pgsodium fix + plaintext fallback
-- ============================================================================
--
-- On Supabase local Docker:
-- 1. `postgres` is NOT a superuser — `supabase_admin` is
-- 2. vault.decrypted_secrets may fail with pgsodium errors
--
-- This script re-creates vault-accessing RPCs as supabase_admin with
-- a dual strategy: try vault first, fallback to secret_plain column.
--
-- Usage after `supabase db reset`:
--   docker exec -i supabase_db_IDS-hackathon-2026 psql -h 127.0.0.1 -U supabase_admin -d postgres \
--     < supabase/local-only/fix-vault-ownership.sql
--
-- NOTE: Connect as supabase_admin (-h 127.0.0.1 -U supabase_admin), NOT postgres.
-- ============================================================================

-- Ensure plaintext fallback column exists
ALTER TABLE public.user_api_keys ADD COLUMN IF NOT EXISTS secret_plain TEXT;
ALTER TABLE public.user_api_keys ALTER COLUMN vault_id DROP NOT NULL;

-- ── insert_api_key ──────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.insert_api_key(TEXT, TEXT, TEXT, TEXT);
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

  IF length(p_secret) >= 6 THEN
    v_hint := left(p_secret, 3) || '...' || right(p_secret, 3);
  ELSE
    v_hint := '***';
  END IF;

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

  -- Try vault, fallback to dummy vault_id
  BEGIN
    INSERT INTO vault.secrets (secret) VALUES (p_secret) RETURNING id INTO v_vault_id;
  EXCEPTION WHEN OTHERS THEN
    v_vault_id := gen_random_uuid();
  END;

  -- Always store plaintext for local reliability
  INSERT INTO user_api_keys (user_id, provider, vault_id, secret_plain, label, key_hint, default_model)
  VALUES (v_user_id, p_provider, v_vault_id, p_secret, v_label, v_hint, p_default_model)
  RETURNING id INTO v_key_id;

  IF (SELECT count(*) FROM user_api_keys WHERE user_id = v_user_id) = 1 THEN
    UPDATE user_api_keys SET is_default = true WHERE id = v_key_id;
  END IF;

  RETURN v_key_id;
END;
$$;

-- ── update_api_key ──────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.update_api_key(UUID, TEXT, TEXT, TEXT);
CREATE FUNCTION public.update_api_key(
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

  SELECT vault_id INTO v_old_vault
  FROM user_api_keys
  WHERE id = p_key_id AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Key not found';
  END IF;

  IF p_secret IS NOT NULL THEN
    BEGIN
      DELETE FROM vault.secrets WHERE id = v_old_vault;
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
      INSERT INTO vault.secrets (secret) VALUES (p_secret) RETURNING id INTO v_vault_id;
    EXCEPTION WHEN OTHERS THEN
      v_vault_id := gen_random_uuid();
    END;

    IF length(p_secret) >= 6 THEN
      v_hint := left(p_secret, 3) || '...' || right(p_secret, 3);
    ELSE
      v_hint := '***';
    END IF;

    UPDATE user_api_keys
    SET vault_id = v_vault_id, secret_plain = p_secret, key_hint = v_hint, updated_at = now()
    WHERE id = p_key_id;
  END IF;

  IF p_label IS NOT NULL THEN
    UPDATE user_api_keys SET label = p_label, updated_at = now() WHERE id = p_key_id;
  END IF;

  IF p_default_model IS NOT NULL THEN
    UPDATE user_api_keys SET default_model = p_default_model, updated_at = now() WHERE id = p_key_id;
  END IF;
END;
$$;

-- ── delete_api_key ──────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.delete_api_key(UUID);
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

  BEGIN
    DELETE FROM vault.secrets WHERE id = v_vault_id;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  DELETE FROM user_api_keys WHERE id = p_key_id AND user_id = v_user_id;
END;
$$;

-- ── set_default_api_key ─────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.set_default_api_key(UUID);
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

  IF NOT EXISTS (SELECT 1 FROM user_api_keys WHERE id = p_key_id AND user_id = v_user_id) THEN
    RAISE EXCEPTION 'Key not found';
  END IF;

  UPDATE user_api_keys SET is_default = false WHERE user_id = v_user_id;
  UPDATE user_api_keys SET is_default = true WHERE id = p_key_id;
END;
$$;

-- ── update_key_default_model ────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.update_key_default_model(UUID, TEXT);
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

-- ── get_api_key (vault decrypt with plaintext fallback) ─────────────────────

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
  v_plain    TEXT;
BEGIN
  SELECT k.vault_id, k.secret_plain INTO v_vault_id, v_plain
  FROM user_api_keys k
  WHERE k.user_id = v_user_id AND k.provider = p_provider AND k.is_default = true
  LIMIT 1;

  IF v_vault_id IS NULL AND v_plain IS NULL THEN
    SELECT k.vault_id, k.secret_plain INTO v_vault_id, v_plain
    FROM user_api_keys k
    WHERE k.user_id = v_user_id AND k.provider = p_provider
    ORDER BY k.created_at ASC
    LIMIT 1;
  END IF;

  IF v_vault_id IS NULL AND v_plain IS NULL THEN
    RETURN NULL;
  END IF;

  -- Try vault decrypt first
  IF v_vault_id IS NOT NULL THEN
    BEGIN
      SELECT ds.decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets ds
      WHERE ds.id = v_vault_id;
      IF v_secret IS NOT NULL THEN RETURN v_secret; END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN v_plain;
END;
$$;

-- ── get_api_key_for_user (service-role, used by Temporal) ───────────────────

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
  v_plain    TEXT;
BEGIN
  SELECT k.vault_id, k.secret_plain INTO v_vault_id, v_plain
  FROM user_api_keys k
  WHERE k.user_id = p_user_id AND k.provider = p_provider AND k.is_default = true
  LIMIT 1;

  IF v_vault_id IS NULL AND v_plain IS NULL THEN
    SELECT k.vault_id, k.secret_plain INTO v_vault_id, v_plain
    FROM user_api_keys k
    WHERE k.user_id = p_user_id AND k.provider = p_provider
    ORDER BY k.created_at ASC
    LIMIT 1;
  END IF;

  IF v_vault_id IS NULL AND v_plain IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_vault_id IS NOT NULL THEN
    BEGIN
      SELECT ds.decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets ds
      WHERE ds.id = v_vault_id;
      IF v_secret IS NOT NULL THEN RETURN v_secret; END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN v_plain;
END;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION public.insert_api_key(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_api_key(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_api_key(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_default_api_key(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_key_default_model(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_api_key(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_api_key_for_user(UUID, TEXT) TO service_role;
