-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 010: Default model preference
-- Adds a default_model column to user_settings so users can persist their
-- preferred chat model across sessions.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Add column ────────────────────────────────────────────────────────────
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS default_model TEXT;

-- ── Update get_or_create_settings to return the new column ────────────────
-- (returns entire row, so no change needed — Postgres will include default_model)

-- ── Replace update_settings to accept optional model ──────────────────────
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
