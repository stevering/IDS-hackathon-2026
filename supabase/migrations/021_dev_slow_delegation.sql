-- Add dev_slow_delegation to user_settings (developer sub-option)
-- When enabled (dev-only), all orchestration timeouts are extended to allow
-- interactive delegation where the human/Claude Code discusses each step.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS dev_slow_delegation BOOLEAN NOT NULL DEFAULT false;

-- Recreate get_or_create_settings (return type changed with new column)
DROP FUNCTION IF EXISTS get_or_create_settings();

CREATE OR REPLACE FUNCTION get_or_create_settings()
RETURNS SETOF user_settings
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO user_settings (user_id)
  VALUES (auth.uid())
  ON CONFLICT (user_id) DO NOTHING;

  RETURN QUERY
  SELECT * FROM user_settings WHERE user_id = auth.uid();
END;
$$;

-- Recreate update_settings with new param
DROP FUNCTION IF EXISTS update_settings(boolean, text, text, boolean, boolean, boolean, boolean);

CREATE OR REPLACE FUNCTION update_settings(
  p_auto_accept          BOOLEAN DEFAULT NULL,
  p_default_model        TEXT    DEFAULT NULL,
  p_approval_mode        TEXT    DEFAULT NULL,
  p_guard_enabled        BOOLEAN DEFAULT NULL,
  p_developer_mode       BOOLEAN DEFAULT NULL,
  p_dev_show_all_events  BOOLEAN DEFAULT NULL,
  p_dev_llm_delegation   BOOLEAN DEFAULT NULL,
  p_dev_slow_delegation  BOOLEAN DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_approval_mode IS NOT NULL AND p_approval_mode NOT IN ('trust', 'brave') THEN
    RAISE EXCEPTION 'approval_mode must be trust or brave';
  END IF;

  INSERT INTO user_settings (user_id)
  VALUES (auth.uid())
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE user_settings
  SET
    auto_accept          = COALESCE(p_auto_accept, auto_accept),
    default_model        = COALESCE(p_default_model, default_model),
    approval_mode        = COALESCE(p_approval_mode, approval_mode),
    guard_enabled        = COALESCE(p_guard_enabled, guard_enabled),
    developer_mode       = COALESCE(p_developer_mode, developer_mode),
    dev_show_all_events  = COALESCE(p_dev_show_all_events, dev_show_all_events),
    dev_llm_delegation   = COALESCE(p_dev_llm_delegation, dev_llm_delegation),
    dev_slow_delegation  = COALESCE(p_dev_slow_delegation, dev_slow_delegation),
    updated_at           = now()
  WHERE user_id = auth.uid();
END;
$$;
