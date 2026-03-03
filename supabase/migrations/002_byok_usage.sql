-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 002 — BYOK 3 modes + usage tracking
-- Applique sur DB existante ayant déjà : user_api_keys + upsert/get/delete RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Ajouter is_default sur user_api_keys
ALTER TABLE public.user_api_keys
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Table de suivi d'usage mensuel
CREATE TABLE IF NOT EXISTS public.user_usage (
  user_id  UUID    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month    DATE    NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

ALTER TABLE public.user_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own usage"
  ON public.user_usage FOR SELECT USING (auth.uid() = user_id);

-- 3. Remplacer upsert_api_key (ajout auto-default sur première clé)
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
  FROM public.user_api_keys WHERE user_id = v_user_id AND provider = p_provider;
  SELECT NOT EXISTS (
    SELECT 1 FROM public.user_api_keys WHERE user_id = v_user_id
  ) INTO v_is_first;
  IF v_existing IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing, p_secret);
    UPDATE public.user_api_keys SET updated_at = now()
      WHERE user_id = v_user_id AND provider = p_provider;
  ELSE
    v_vault_id := vault.create_secret(p_secret, p_provider || '_key_' || v_user_id::text);
    INSERT INTO public.user_api_keys (user_id, provider, vault_id, is_default)
      VALUES (v_user_id, p_provider, v_vault_id, v_is_first);
  END IF;
END; $$;

-- 4. Remplacer delete_api_key (promo automatique si default supprimée)
CREATE OR REPLACE FUNCTION public.delete_api_key(p_provider TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_vault_id    UUID;
  v_was_default BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT vault_id, is_default INTO v_vault_id, v_was_default
  FROM public.user_api_keys WHERE user_id = v_user_id AND provider = p_provider;
  IF v_vault_id IS NOT NULL THEN
    DELETE FROM public.user_api_keys WHERE user_id = v_user_id AND provider = p_provider;
    DELETE FROM vault.secrets WHERE id = v_vault_id;
    IF v_was_default THEN
      UPDATE public.user_api_keys SET is_default = TRUE
        WHERE user_id = v_user_id AND id = (
          SELECT id FROM public.user_api_keys WHERE user_id = v_user_id
          ORDER BY created_at ASC LIMIT 1
        );
    END IF;
  END IF;
END; $$;

-- 5. Nouveaux RPCs
CREATE OR REPLACE FUNCTION public.set_default_api_key(p_provider TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE public.user_api_keys SET is_default = FALSE WHERE user_id = v_user_id;
  UPDATE public.user_api_keys SET is_default = TRUE
    WHERE user_id = v_user_id AND provider = p_provider;
END; $$;

CREATE OR REPLACE FUNCTION public.increment_usage(p_user_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_month DATE := date_trunc('month', now())::date;
  v_count INTEGER;
BEGIN
  INSERT INTO public.user_usage (user_id, month, messages)
    VALUES (p_user_id, v_month, 1)
    ON CONFLICT (user_id, month)
    DO UPDATE SET messages = public.user_usage.messages + 1
    RETURNING messages INTO v_count;
  RETURN v_count;
END; $$;

CREATE OR REPLACE FUNCTION public.get_current_usage()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_month   DATE := date_trunc('month', now())::date;
  v_count   INTEGER;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT COALESCE(messages, 0) INTO v_count
  FROM public.user_usage WHERE user_id = v_user_id AND month = v_month;
  RETURN COALESCE(v_count, 0);
END; $$;
