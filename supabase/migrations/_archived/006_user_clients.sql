-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 006: User client registry
-- Server-side persistence for client instances (stable shortIds, audit trail)
-- Complements Supabase Realtime Presence (ephemeral) with stable identities
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Table ─────────────────────────────────────────────────────────────────
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

-- ── RLS ───────────────────────────────────────────────────────────────────
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

  -- Assign prefix based on client_type
  v_prefix := CASE p_client_type
    WHEN 'figma-plugin' THEN 'A'
    WHEN 'webapp'        THEN 'B'
    WHEN 'overlay'       THEN 'C'
    ELSE 'X'
  END;

  -- Find next sequential number for this user + type (no recycling)
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
