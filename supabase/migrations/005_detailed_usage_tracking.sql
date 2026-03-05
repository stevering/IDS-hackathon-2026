-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 005: Detailed token + cost tracking per interaction
-- Adds input/output token breakdown, model name, and real cost in USD
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Drop old functions whose return type changes (INTEGER → usage_aggregate) ─
DROP FUNCTION IF EXISTS public.increment_usage(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.get_current_usage();
DROP FUNCTION IF EXISTS public.get_usage_for_user(UUID);
DROP FUNCTION IF EXISTS public.cleanup_old_usage();

-- ── Alter user_usage_log: split tokens into input/output + add cost ───────
ALTER TABLE public.user_usage_log RENAME COLUMN tokens TO output_tokens;
ALTER TABLE public.user_usage_log ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.user_usage_log ADD COLUMN model TEXT;
ALTER TABLE public.user_usage_log ADD COLUMN cost_input_usd NUMERIC(12,8) NOT NULL DEFAULT 0;
ALTER TABLE public.user_usage_log ADD COLUMN cost_output_usd NUMERIC(12,8) NOT NULL DEFAULT 0;

-- ── New table: model pricing cache (refreshed daily from Vercel AI Gateway) ─
CREATE TABLE IF NOT EXISTS public.model_pricing_cache (
  model_id         TEXT PRIMARY KEY,
  input_per_token  NUMERIC(16,12) NOT NULL,
  output_per_token NUMERIC(16,12) NOT NULL,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── RPC: detailed usage increment ─────────────────────────────────────────
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

-- ── Custom return type for detailed usage aggregates ──────────────────────
DROP TYPE IF EXISTS public.usage_aggregate CASCADE;
CREATE TYPE public.usage_aggregate AS (
  total_tokens    INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_input_usd  NUMERIC,
  cost_output_usd NUMERIC
);

-- ── RPC: get rolling 24h usage (authenticated user) ──────────────────────
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

-- ── RPC: get rolling 24h total tokens for a user (server-side, limit check) ─
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

-- ── RPC: get rolling 30-day usage (authenticated user) ───────────────────
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

-- ── RPC: get lifetime usage (authenticated user) ─────────────────────────
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

-- ── Update cleanup to keep 48h (unchanged logic, new columns included) ───
CREATE OR REPLACE FUNCTION public.cleanup_old_usage()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.user_usage_log WHERE created_at < now() - interval '48 hours';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END; $$;
