-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 004: Switch from monthly message count to rolling 24h token usage
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop old monthly message-counting table
DROP TABLE IF EXISTS public.user_usage;

-- New log-based table for rolling 24h token tracking
CREATE TABLE public.user_usage_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tokens     INTEGER     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_log_user_time ON public.user_usage_log (user_id, created_at DESC);

ALTER TABLE public.user_usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own usage"
  ON public.user_usage_log FOR SELECT USING (auth.uid() = user_id);

-- ── RPC: add token usage (called server-side via service role) ────────────
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

-- ── RPC: get rolling 24h token usage (called by authenticated user) ──────
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

-- ── RPC: get usage for a specific user (called server-side via service role) ─
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

-- ── RPC: cleanup old records (call periodically via cron or manually) ─────
CREATE OR REPLACE FUNCTION public.cleanup_old_usage()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.user_usage_log WHERE created_at < now() - interval '48 hours';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END; $$;
