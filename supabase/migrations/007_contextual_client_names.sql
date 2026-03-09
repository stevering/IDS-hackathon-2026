-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 007: Contextual client names
-- Replace generic #B1/#A1 shortIds with contextual names like #Chrome-kobita
-- Add rename_client() RPC for user-initiated renames
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Helper: generate a random pronounceable syllable suffix ──────────────
-- Alternates consonant-vowel for 3 syllables (6 chars).
-- ~512,000 combinations per call — collision per user is extremely unlikely.
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

-- ── Helper: derive a browser/context prefix from client_type + label ─────
CREATE OR REPLACE FUNCTION public.derive_client_prefix(
  p_client_type TEXT,
  p_label       TEXT
)
RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  -- Figma plugin: distinguish Desktop vs Web via label sent by client
  IF p_client_type = 'figma-plugin' THEN
    IF p_label ILIKE '%figma-desktop%' THEN RETURN 'Figma-Desktop'; END IF;
    IF p_label ILIKE '%figma-web%'     THEN RETURN 'Figma-Web'; END IF;
    RETURN 'Figma';
  END IF;

  IF p_client_type = 'overlay' THEN RETURN 'Overlay'; END IF;

  -- Webapp: detect browser from the label (extracted from user-agent)
  IF p_label ILIKE '%chrome%'  THEN RETURN 'Chrome'; END IF;
  IF p_label ILIKE '%firefox%' THEN RETURN 'Firefox'; END IF;
  IF p_label ILIKE '%safari%'  THEN RETURN 'Safari'; END IF;
  IF p_label ILIKE '%edge%'    THEN RETURN 'Edge'; END IF;
  IF p_label ILIKE '%arc%'     THEN RETURN 'Arc'; END IF;
  IF p_label ILIKE '%opera%'   THEN RETURN 'Opera'; END IF;
  IF p_label ILIKE '%brave%'   THEN RETURN 'Brave'; END IF;

  RETURN 'App';
END; $$;

-- ── Replace register_client() with contextual name generation ────────────
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

  -- Check if this client_id already exists for this user
  SELECT uc.short_id INTO v_existing
  FROM public.user_clients uc
  WHERE uc.user_id = v_user_id AND uc.client_id = p_client_id;

  IF v_existing IS NOT NULL THEN
    -- Client already registered: update last_seen, label, file_key
    UPDATE public.user_clients
    SET last_seen_at = now(),
        label = COALESCE(p_label, public.user_clients.label),
        file_key = COALESCE(p_file_key, public.user_clients.file_key)
    WHERE public.user_clients.user_id = v_user_id AND public.user_clients.client_id = p_client_id;

    RETURN QUERY SELECT v_existing, FALSE;
    RETURN;
  END IF;

  -- Derive contextual prefix from type + label
  v_prefix := derive_client_prefix(p_client_type, COALESCE(p_label, ''));

  -- Generate unique shortId with collision avoidance (max 10 attempts)
  LOOP
    v_suffix := generate_syllable_suffix();
    v_short_id := '#' || v_prefix || '-' || v_suffix;

    -- Check uniqueness within this user's clients
    IF NOT EXISTS (
      SELECT 1 FROM public.user_clients uc
      WHERE uc.user_id = v_user_id AND uc.short_id = v_short_id
    ) THEN
      EXIT; -- unique, proceed
    END IF;

    v_attempt := v_attempt + 1;
    IF v_attempt >= 10 THEN
      -- Extremely unlikely fallback: append random digit
      v_short_id := v_short_id || floor(random() * 10)::int::text;
      EXIT;
    END IF;
  END LOOP;

  INSERT INTO public.user_clients (user_id, client_id, client_type, short_id, label, file_key)
  VALUES (v_user_id, p_client_id, p_client_type, v_short_id, p_label, p_file_key);

  RETURN QUERY SELECT v_short_id, TRUE;
END; $$;

-- ── RPC: rename a client (user-initiated) ────────────────────────────────
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
