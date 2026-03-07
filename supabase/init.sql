-- ═══════════════════════════════════════════════════════════════════════════
-- Guardian — Supabase init complet (from scratch)
-- Prérequis : activer pgsodium + supabase_vault dans Database > Extensions
-- auth.users est géré automatiquement par Supabase Auth
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Table : clés API utilisateurs (chiffrées dans Vault) ─────────────────────
CREATE TABLE IF NOT EXISTS public.user_api_keys (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider   TEXT        NOT NULL,
  -- 'gateway'   → clé Vercel AI Gateway (BYOK unifié, accès à tous les modèles)
  -- 'openai'    → clé OpenAI directe
  -- 'anthropic' → clé Anthropic directe
  -- 'google'    → clé Google/Gemini directe
  -- 'xai'       → clé XAI/Grok directe
  vault_id   UUID        NOT NULL,
  is_default BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

ALTER TABLE public.user_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own keys"
  ON public.user_api_keys FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users insert own keys"
  ON public.user_api_keys FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own keys"
  ON public.user_api_keys FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own keys"
  ON public.user_api_keys FOR DELETE USING (auth.uid() = user_id);

-- ── Table : detailed token + cost usage log (free tier, rolling 24h) ─────────
CREATE TABLE IF NOT EXISTS public.user_usage_log (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  input_tokens    INTEGER     NOT NULL DEFAULT 0,
  output_tokens   INTEGER     NOT NULL DEFAULT 0,
  model           TEXT,
  cost_input_usd  NUMERIC(12,8) NOT NULL DEFAULT 0,
  cost_output_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_log_user_time ON public.user_usage_log (user_id, created_at DESC);

ALTER TABLE public.user_usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own usage"
  ON public.user_usage_log FOR SELECT USING (auth.uid() = user_id);

-- ── Table : model pricing cache (refreshed daily from Vercel AI Gateway) ─────
CREATE TABLE IF NOT EXISTS public.model_pricing_cache (
  model_id         TEXT PRIMARY KEY,
  input_per_token  NUMERIC(16,12) NOT NULL,
  output_per_token NUMERIC(16,12) NOT NULL,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── RPC : stocker / mettre à jour une clé dans le Vault ──────────────────────
CREATE OR REPLACE FUNCTION public.upsert_api_key(p_provider TEXT, p_secret TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_vault_id UUID;
  v_existing UUID;
  v_is_first BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT vault_id INTO v_existing
  FROM public.user_api_keys
  WHERE user_id = v_user_id AND provider = p_provider;

  -- Première clé de l'utilisateur → devient default automatiquement
  SELECT NOT EXISTS (
    SELECT 1 FROM public.user_api_keys WHERE user_id = v_user_id
  ) INTO v_is_first;

  IF v_existing IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing, p_secret);
    UPDATE public.user_api_keys
      SET updated_at = now()
      WHERE user_id = v_user_id AND provider = p_provider;
  ELSE
    v_vault_id := vault.create_secret(
      p_secret,
      p_provider || '_key_' || v_user_id::text
    );
    INSERT INTO public.user_api_keys (user_id, provider, vault_id, is_default)
      VALUES (v_user_id, p_provider, v_vault_id, v_is_first);
  END IF;
END; $$;

-- ── RPC : lire une clé déchiffrée depuis le Vault ────────────────────────────
CREATE OR REPLACE FUNCTION public.get_api_key(p_provider TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_vault_id UUID;
  v_secret   TEXT;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT vault_id INTO v_vault_id
  FROM public.user_api_keys
  WHERE user_id = v_user_id AND provider = p_provider;
  IF v_vault_id IS NULL THEN RETURN NULL; END IF;
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE id = v_vault_id;
  RETURN v_secret;
END; $$;

-- ── RPC : supprimer une clé ───────────────────────────────────────────────────
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
    DELETE FROM public.user_api_keys
      WHERE user_id = v_user_id AND provider = p_provider;
    DELETE FROM vault.secrets WHERE id = v_vault_id;
    -- Si on supprime la clé par défaut, promouvoir la plus ancienne restante
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

-- ── RPC : changer la clé par défaut ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_default_api_key(p_provider TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE public.user_api_keys SET is_default = FALSE WHERE user_id = v_user_id;
  UPDATE public.user_api_keys SET is_default = TRUE
    WHERE user_id = v_user_id AND provider = p_provider;
END; $$;

-- ── Custom return type for detailed usage aggregates ──────────────────────────
CREATE TYPE public.usage_aggregate AS (
  total_tokens    INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_input_usd  NUMERIC,
  cost_output_usd NUMERIC
);

-- ── RPC : detailed usage increment (called server-side via service role) ─────
CREATE OR REPLACE FUNCTION public.increment_usage(
  p_user_id       UUID,
  p_input_tokens  INTEGER,
  p_output_tokens INTEGER,
  p_model         TEXT DEFAULT NULL,
  p_cost_input    NUMERIC DEFAULT 0,
  p_cost_output   NUMERIC DEFAULT 0
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total INTEGER;
BEGIN
  INSERT INTO public.user_usage_log (user_id, input_tokens, output_tokens, model, cost_input_usd, cost_output_usd)
    VALUES (p_user_id, p_input_tokens, p_output_tokens, p_model, p_cost_input, p_cost_output);
  SELECT COALESCE(SUM(input_tokens + output_tokens), 0) INTO v_total
    FROM public.user_usage_log
    WHERE user_id = p_user_id AND created_at > now() - interval '24 hours';
  RETURN v_total;
END; $$;

-- ── RPC : get rolling 24h usage (authenticated user) ─────────────────────────
CREATE OR REPLACE FUNCTION public.get_current_usage()
RETURNS public.usage_aggregate LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_result  public.usage_aggregate;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT
    COALESCE(SUM(input_tokens + output_tokens), 0),
    COALESCE(SUM(input_tokens), 0),
    COALESCE(SUM(output_tokens), 0),
    COALESCE(SUM(cost_input_usd), 0),
    COALESCE(SUM(cost_output_usd), 0)
  INTO v_result
  FROM public.user_usage_log
  WHERE user_id = v_user_id AND created_at > now() - interval '24 hours';
  RETURN v_result;
END; $$;

-- ── RPC : get rolling 24h total tokens for a user (server-side, limit check) ─
CREATE OR REPLACE FUNCTION public.get_usage_for_user(p_user_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total INTEGER;
BEGIN
  SELECT COALESCE(SUM(input_tokens + output_tokens), 0) INTO v_total
    FROM public.user_usage_log
    WHERE user_id = p_user_id AND created_at > now() - interval '24 hours';
  RETURN v_total;
END; $$;

-- ── RPC : get rolling 30-day usage (authenticated user) ──────────────────────
CREATE OR REPLACE FUNCTION public.get_monthly_usage()
RETURNS public.usage_aggregate LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_result  public.usage_aggregate;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT
    COALESCE(SUM(input_tokens + output_tokens), 0),
    COALESCE(SUM(input_tokens), 0),
    COALESCE(SUM(output_tokens), 0),
    COALESCE(SUM(cost_input_usd), 0),
    COALESCE(SUM(cost_output_usd), 0)
  INTO v_result
  FROM public.user_usage_log
  WHERE user_id = v_user_id AND created_at > now() - interval '30 days';
  RETURN v_result;
END; $$;

-- ── RPC : get lifetime usage (authenticated user) ────────────────────────────
CREATE OR REPLACE FUNCTION public.get_lifetime_usage()
RETURNS public.usage_aggregate LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_result  public.usage_aggregate;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT
    COALESCE(SUM(input_tokens + output_tokens), 0),
    COALESCE(SUM(input_tokens), 0),
    COALESCE(SUM(output_tokens), 0),
    COALESCE(SUM(cost_input_usd), 0),
    COALESCE(SUM(cost_output_usd), 0)
  INTO v_result
  FROM public.user_usage_log
  WHERE user_id = v_user_id;
  RETURN v_result;
END; $$;

-- ── RPC : cleanup old records (call periodically via cron or manually) ───────
CREATE OR REPLACE FUNCTION public.cleanup_old_usage()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.user_usage_log WHERE created_at < now() - interval '48 hours';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END; $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- User client registry — stable identities for connected instances
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.user_clients (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id    TEXT        NOT NULL,
  client_type  TEXT        NOT NULL,
  short_id     TEXT        NOT NULL,
  label        TEXT,
  file_key     TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_user_clients_user
  ON public.user_clients (user_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_clients_type
  ON public.user_clients (user_id, client_type);

ALTER TABLE public.user_clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own clients"
  ON public.user_clients FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users manage own clients"
  ON public.user_clients FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── RPC: register a client and atomically assign a stable shortId ─────────
CREATE OR REPLACE FUNCTION public.register_client(
  p_client_id   TEXT,
  p_client_type TEXT,
  p_label       TEXT DEFAULT NULL,
  p_file_key    TEXT DEFAULT NULL
)
RETURNS TABLE(short_id TEXT, is_new BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_existing TEXT;
  v_prefix   TEXT;
  v_next_num INTEGER;
  v_short_id TEXT;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT uc.short_id INTO v_existing
  FROM public.user_clients uc
  WHERE uc.user_id = v_user_id AND uc.client_id = p_client_id;

  IF v_existing IS NOT NULL THEN
    UPDATE public.user_clients
    SET last_seen_at = now(),
        label = COALESCE(p_label, public.user_clients.label),
        file_key = COALESCE(p_file_key, public.user_clients.file_key)
    WHERE public.user_clients.user_id = v_user_id AND public.user_clients.client_id = p_client_id;

    RETURN QUERY SELECT v_existing, FALSE;
    RETURN;
  END IF;

  v_prefix := CASE p_client_type
    WHEN 'figma-plugin' THEN 'A'
    WHEN 'webapp'        THEN 'B'
    WHEN 'overlay'       THEN 'C'
    ELSE 'X'
  END;

  SELECT COALESCE(MAX(
    CAST(SUBSTRING(uc.short_id FROM 3) AS INTEGER)
  ), 0) + 1
  INTO v_next_num
  FROM public.user_clients uc
  WHERE uc.user_id = v_user_id AND uc.client_type = p_client_type;

  v_short_id := '#' || v_prefix || v_next_num::TEXT;

  INSERT INTO public.user_clients (user_id, client_id, client_type, short_id, label, file_key)
  VALUES (v_user_id, p_client_id, p_client_type, v_short_id, p_label, p_file_key);

  RETURN QUERY SELECT v_short_id, TRUE;
END; $$;

-- ── RPC: heartbeat (update last_seen + optional metadata) ─────────────────
CREATE OR REPLACE FUNCTION public.heartbeat_client(
  p_client_id TEXT,
  p_file_key  TEXT DEFAULT NULL,
  p_label     TEXT DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE public.user_clients
  SET last_seen_at = now(),
      file_key = COALESCE(p_file_key, public.user_clients.file_key),
      label = COALESCE(p_label, public.user_clients.label)
  WHERE public.user_clients.user_id = v_user_id AND public.user_clients.client_id = p_client_id;
END; $$;

-- ── RPC: unregister a client ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.unregister_client(p_client_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  DELETE FROM public.user_clients
  WHERE public.user_clients.user_id = v_user_id AND public.user_clients.client_id = p_client_id;
END; $$;

-- ── RPC: cleanup stale clients (> 24h without heartbeat) ──────────────────
CREATE OR REPLACE FUNCTION public.cleanup_stale_clients()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted INTEGER;
BEGIN
  DELETE FROM public.user_clients
  WHERE last_seen_at < now() - interval '24 hours';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END; $$;
