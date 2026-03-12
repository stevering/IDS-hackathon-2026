-- ═══════════════════════════════════════════════════════════════════════════
-- Guardian — Squashed init migration (replaces migrations 002 through 011)
-- Matches production schema exactly as of 2026-03-12
--
-- Prerequisites:
--   - Supabase Auth (auth.users managed automatically)
--   - pgsodium + supabase_vault extensions enabled (Database > Extensions)
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  1. TABLES (in dependency order)                                        ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝


-- ── 1a. user_api_keys ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_api_keys (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider   TEXT        NOT NULL,
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


-- ── 1b. user_usage_log ───────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS idx_usage_log_user_time
  ON public.user_usage_log (user_id, created_at DESC);

ALTER TABLE public.user_usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own usage"
  ON public.user_usage_log FOR SELECT USING (auth.uid() = user_id);


-- ── 1c. model_pricing_cache ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.model_pricing_cache (
  model_id         TEXT PRIMARY KEY,
  input_per_token  NUMERIC(16,12) NOT NULL,
  output_per_token NUMERIC(16,12) NOT NULL,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.model_pricing_cache ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only access (RLS with no policies blocks anon/authenticated)


-- ── 1d. conversations ────────────────────────────────────────────────────
-- (orchestration_id FK added after orchestrations table is created)

CREATE TABLE IF NOT EXISTS public.conversations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id        TEXT,
  title            TEXT        NOT NULL DEFAULT 'New conversation',
  is_active        BOOLEAN     NOT NULL DEFAULT FALSE,
  parent_id        UUID        REFERENCES public.conversations(id) ON DELETE SET NULL,
  orchestration_id UUID,
  metadata         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user
  ON public.conversations (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_client
  ON public.conversations (user_id, client_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_conversations_orchestration
  ON public.conversations (orchestration_id)
  WHERE orchestration_id IS NOT NULL;

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own conversations"
  ON public.conversations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users manage own conversations"
  ON public.conversations FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ── 1e. messages ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.messages (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role             TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content          TEXT        NOT NULL,
  parts            JSONB,
  sender_client_id TEXT,
  sender_short_id  TEXT,
  metadata         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON public.messages (conversation_id, created_at ASC);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own messages"
  ON public.messages FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id AND c.user_id = auth.uid()
  ));

CREATE POLICY "users insert own messages"
  ON public.messages FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id AND c.user_id = auth.uid()
  ));

CREATE POLICY "users delete own messages"
  ON public.messages FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id AND c.user_id = auth.uid()
  ));


-- ── 1f. orchestrations ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.orchestrations (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  orchestrator_client_id TEXT        NOT NULL,
  conversation_id        UUID        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  status                 TEXT        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orchestrations_user
  ON public.orchestrations (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestrations_status
  ON public.orchestrations (user_id, status)
  WHERE status = 'active';

ALTER TABLE public.orchestrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own orchestrations"
  ON public.orchestrations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users manage own orchestrations"
  ON public.orchestrations FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ── 1f-bis. conversations.orchestration_id FK ────────────────────────────
-- Now that orchestrations table exists, add the foreign key

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_orchestration_id_fkey
  FOREIGN KEY (orchestration_id)
  REFERENCES public.orchestrations(id)
  ON DELETE SET NULL;


-- ── 1g. user_clients ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_clients (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id        TEXT        NOT NULL,
  client_type      TEXT        NOT NULL,
  short_id         TEXT        NOT NULL,
  label            TEXT,
  file_key         TEXT,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_role       TEXT        NOT NULL DEFAULT 'idle'
                   CHECK (agent_role IN ('idle', 'orchestrator', 'collaborator')),
  orchestration_id UUID        REFERENCES public.orchestrations(id) ON DELETE SET NULL,
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


-- ── 1h. user_settings ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id       UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  auto_accept   BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  default_model TEXT
);

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own settings"
  ON public.user_settings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users manage own settings"
  ON public.user_settings FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  2. CUSTOM TYPES                                                        ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'usage_aggregate') THEN
    CREATE TYPE public.usage_aggregate AS (
      total_tokens    INTEGER,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      cost_input_usd  NUMERIC,
      cost_output_usd NUMERIC
    );
  END IF;
END;
$$;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  3. TRIGGER FUNCTIONS                                                   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION public.update_conversation_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_conversation_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_conversation_timestamp();


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  4. HELPER FUNCTIONS (no SECURITY DEFINER)                              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ── generate_syllable_suffix ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.generate_syllable_suffix()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  consonants TEXT[] := ARRAY['b','c','d','f','g','h','k','l','m','n','p','r','s','t','v','z'];
  vowels TEXT[] := ARRAY['a','e','i','o','u'];
  result TEXT := '';
  i INTEGER;
BEGIN
  FOR i IN 1..3 LOOP
    result := result || consonants[1 + floor(random() * array_length(consonants, 1))::int];
    result := result || vowels[1 + floor(random() * array_length(vowels, 1))::int];
  END LOOP;
  RETURN result;
END; $$;

-- ── derive_client_prefix ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.derive_client_prefix(
  p_client_type TEXT,
  p_label       TEXT
)
RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  IF p_client_type = 'figma-plugin' THEN
    IF p_label ILIKE '%figma-desktop%' THEN RETURN 'Figma-Desktop'; END IF;
    IF p_label ILIKE '%figma-web%'     THEN RETURN 'Figma-Web'; END IF;
    RETURN 'Figma';
  END IF;

  IF p_client_type = 'overlay' THEN RETURN 'Overlay'; END IF;

  IF p_label ILIKE '%chrome%'  THEN RETURN 'Chrome'; END IF;
  IF p_label ILIKE '%firefox%' THEN RETURN 'Firefox'; END IF;
  IF p_label ILIKE '%safari%'  THEN RETURN 'Safari'; END IF;
  IF p_label ILIKE '%edge%'    THEN RETURN 'Edge'; END IF;
  IF p_label ILIKE '%arc%'     THEN RETURN 'Arc'; END IF;
  IF p_label ILIKE '%opera%'   THEN RETURN 'Opera'; END IF;
  IF p_label ILIKE '%brave%'   THEN RETURN 'Brave'; END IF;

  RETURN 'App';
END; $$;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  5. API KEY MANAGEMENT FUNCTIONS (SECURITY DEFINER)                     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ── upsert_api_key ───────────────────────────────────────────────────────

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

-- ── get_api_key ──────────────────────────────────────────────────────────

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

-- ── delete_api_key ───────────────────────────────────────────────────────

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

-- ── set_default_api_key ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_default_api_key(p_provider TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE public.user_api_keys SET is_default = FALSE WHERE user_id = v_user_id;
  UPDATE public.user_api_keys SET is_default = TRUE
    WHERE user_id = v_user_id AND provider = p_provider;
END; $$;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  6. USAGE TRACKING FUNCTIONS (SECURITY DEFINER)                         ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ── increment_usage (server-side via service role) ───────────────────────

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

-- ── get_current_usage (rolling 24h, authenticated user) ──────────────────

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

-- ── get_usage_for_user (server-side, limit check) ────────────────────────

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

-- ── get_monthly_usage (rolling 30 days, authenticated user) ──────────────

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

-- ── get_lifetime_usage (authenticated user) ──────────────────────────────

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

-- ── cleanup_old_usage ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cleanup_old_usage()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.user_usage_log WHERE created_at < now() - interval '48 hours';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END; $$;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  7. CLIENT REGISTRY FUNCTIONS (SECURITY DEFINER)                        ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ── register_client (contextual names with collision avoidance) ──────────

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
  v_suffix   TEXT;
  v_short_id TEXT;
  v_attempt  INTEGER := 0;
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

  v_prefix := derive_client_prefix(p_client_type, COALESCE(p_label, ''));

  LOOP
    v_suffix := generate_syllable_suffix();
    v_short_id := '#' || v_prefix || '-' || v_suffix;

    IF NOT EXISTS (
      SELECT 1 FROM public.user_clients uc
      WHERE uc.user_id = v_user_id AND uc.short_id = v_short_id
    ) THEN
      EXIT;
    END IF;

    v_attempt := v_attempt + 1;
    IF v_attempt >= 10 THEN
      v_short_id := v_short_id || floor(random() * 10)::int::text;
      EXIT;
    END IF;
  END LOOP;

  INSERT INTO public.user_clients (user_id, client_id, client_type, short_id, label, file_key)
  VALUES (v_user_id, p_client_id, p_client_type, v_short_id, p_label, p_file_key);

  RETURN QUERY SELECT v_short_id, TRUE;
END; $$;

-- ── rename_client ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rename_client(
  p_client_id TEXT,
  p_short_id  TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF length(trim(p_short_id)) < 2 OR length(trim(p_short_id)) > 30 THEN
    RAISE EXCEPTION 'Name must be between 2 and 30 characters';
  END IF;

  UPDATE public.user_clients
  SET short_id = trim(p_short_id)
  WHERE user_id = v_user_id AND client_id = p_client_id;
END; $$;

-- ── heartbeat_client ─────────────────────────────────────────────────────

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

-- ── unregister_client ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.unregister_client(p_client_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  DELETE FROM public.user_clients
  WHERE public.user_clients.user_id = v_user_id AND public.user_clients.client_id = p_client_id;
END; $$;

-- ── cleanup_stale_clients ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cleanup_stale_clients()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted INTEGER;
BEGIN
  DELETE FROM public.user_clients
  WHERE last_seen_at < now() - interval '24 hours';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END; $$;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  8. CONVERSATION & MESSAGE FUNCTIONS (SECURITY DEFINER)                 ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ── create_conversation ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_conversation(
  p_client_id        TEXT    DEFAULT NULL,
  p_title            TEXT    DEFAULT 'New conversation',
  p_parent_id        UUID   DEFAULT NULL,
  p_orchestration_id UUID   DEFAULT NULL,
  p_metadata         JSONB  DEFAULT '{}'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  INSERT INTO conversations (user_id, client_id, title, parent_id, orchestration_id, metadata)
  VALUES (v_uid, p_client_id, p_title, p_parent_id, p_orchestration_id, p_metadata)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── set_active_conversation ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_active_conversation(
  p_conversation_id UUID,
  p_client_id       TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF p_client_id IS NOT NULL THEN
    UPDATE conversations
    SET is_active = FALSE
    WHERE user_id = v_uid AND client_id = p_client_id AND is_active = TRUE AND id <> p_conversation_id;
  ELSE
    UPDATE conversations
    SET is_active = FALSE
    WHERE user_id = v_uid AND is_active = TRUE AND id <> p_conversation_id;
  END IF;

  UPDATE conversations
  SET is_active = TRUE
  WHERE id = p_conversation_id AND user_id = v_uid;
END;
$$;

-- ── save_message ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.save_message(
  p_conversation_id UUID,
  p_role            TEXT,
  p_content         TEXT,
  p_parts           JSONB  DEFAULT NULL,
  p_sender_client_id TEXT  DEFAULT NULL,
  p_sender_short_id  TEXT  DEFAULT NULL,
  p_metadata        JSONB  DEFAULT '{}'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM conversations WHERE id = p_conversation_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  INSERT INTO messages (conversation_id, role, content, parts, sender_client_id, sender_short_id, metadata)
  VALUES (p_conversation_id, p_role, p_content, p_parts, p_sender_client_id, p_sender_short_id, p_metadata)
  RETURNING id INTO v_id;

  UPDATE conversations SET title = title WHERE id = p_conversation_id;

  RETURN v_id;
END;
$$;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  9. ORCHESTRATION FUNCTIONS (SECURITY DEFINER)                          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ── create_orchestration ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_orchestration(
  p_client_id       TEXT,
  p_conversation_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_orch_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_clients
    WHERE user_id = v_uid AND client_id = p_client_id
  ) THEN
    RAISE EXCEPTION 'Client not found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM user_clients
    WHERE user_id = v_uid AND client_id = p_client_id AND agent_role <> 'idle'
  ) THEN
    RAISE EXCEPTION 'Client already has an active role';
  END IF;

  INSERT INTO orchestrations (user_id, orchestrator_client_id, conversation_id)
  VALUES (v_uid, p_client_id, p_conversation_id)
  RETURNING id INTO v_orch_id;

  UPDATE user_clients
  SET agent_role = 'orchestrator', orchestration_id = v_orch_id
  WHERE user_id = v_uid AND client_id = p_client_id;

  RETURN v_orch_id;
END;
$$;

-- ── join_orchestration ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.join_orchestration(
  p_client_id      TEXT,
  p_orchestration_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM orchestrations
    WHERE id = p_orchestration_id AND user_id = v_uid AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Orchestration not found or not active';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM user_clients
    WHERE user_id = v_uid AND client_id = p_client_id AND agent_role = 'idle'
  ) THEN
    RAISE EXCEPTION 'Client not found or not idle';
  END IF;

  UPDATE user_clients
  SET agent_role = 'collaborator', orchestration_id = p_orchestration_id
  WHERE user_id = v_uid AND client_id = p_client_id;
END;
$$;

-- ── complete_orchestration ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.complete_orchestration(
  p_orchestration_id UUID,
  p_status           TEXT DEFAULT 'completed'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM orchestrations
    WHERE id = p_orchestration_id AND user_id = v_uid AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Orchestration not found or not active';
  END IF;

  UPDATE orchestrations
  SET status = p_status, completed_at = now()
  WHERE id = p_orchestration_id;

  UPDATE user_clients
  SET agent_role = 'idle', orchestration_id = NULL
  WHERE user_id = v_uid AND orchestration_id = p_orchestration_id;
END;
$$;

-- ── update_client_role ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_client_role(
  p_client_id        TEXT,
  p_role             TEXT,
  p_orchestration_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  UPDATE user_clients
  SET agent_role = p_role, orchestration_id = p_orchestration_id
  WHERE user_id = v_uid AND client_id = p_client_id;
END;
$$;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  10. USER SETTINGS FUNCTIONS (SECURITY DEFINER)                         ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ── get_or_create_settings ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_or_create_settings()
RETURNS public.user_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.user_settings;
BEGIN
  SELECT * INTO v_row FROM user_settings WHERE user_id = v_uid;
  IF NOT FOUND THEN
    INSERT INTO user_settings (user_id) VALUES (v_uid)
    RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END;
$$;

-- ── update_settings (with default_model support) ─────────────────────────

CREATE OR REPLACE FUNCTION public.update_settings(
  p_auto_accept    BOOLEAN DEFAULT NULL,
  p_default_model  TEXT    DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  INSERT INTO user_settings (user_id, auto_accept, default_model, updated_at)
  VALUES (
    v_uid,
    COALESCE(p_auto_accept, FALSE),
    p_default_model,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    auto_accept   = COALESCE(p_auto_accept,   user_settings.auto_accept),
    default_model = COALESCE(p_default_model,  user_settings.default_model),
    updated_at    = now();
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- End of squashed init migration
-- ═══════════════════════════════════════════════════════════════════════════
