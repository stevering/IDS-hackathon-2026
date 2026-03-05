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

-- ── Table : rolling 24h token usage log (free tier) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.user_usage_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tokens     INTEGER     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_log_user_time ON public.user_usage_log (user_id, created_at DESC);

ALTER TABLE public.user_usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own usage"
  ON public.user_usage_log FOR SELECT USING (auth.uid() = user_id);

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

-- ── RPC : add token usage (called server-side via service role) ──────────────
CREATE OR REPLACE FUNCTION public.increment_usage(p_user_id UUID, p_tokens INTEGER)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total INTEGER;
BEGIN
  INSERT INTO public.user_usage_log (user_id, tokens) VALUES (p_user_id, p_tokens);
  SELECT COALESCE(SUM(tokens), 0) INTO v_total
    FROM public.user_usage_log
    WHERE user_id = p_user_id AND created_at > now() - interval '24 hours';
  RETURN v_total;
END; $$;

-- ── RPC : get rolling 24h token usage ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_current_usage()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_total   INTEGER;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT COALESCE(SUM(tokens), 0) INTO v_total
    FROM public.user_usage_log
    WHERE user_id = v_user_id AND created_at > now() - interval '24 hours';
  RETURN v_total;
END; $$;

-- ── RPC : get usage for a specific user (called server-side via service role) ─
CREATE OR REPLACE FUNCTION public.get_usage_for_user(p_user_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total INTEGER;
BEGIN
  SELECT COALESCE(SUM(tokens), 0) INTO v_total
    FROM public.user_usage_log
    WHERE user_id = p_user_id AND created_at > now() - interval '24 hours';
  RETURN v_total;
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
