-- Add orchestration approval settings to user_settings
-- approval_mode: 'trust' (manual approval for each command) or 'brave' (auto-execute)
-- guard_enabled: when true, critical operations always require approval regardless of mode

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS approval_mode TEXT NOT NULL DEFAULT 'trust',
  ADD COLUMN IF NOT EXISTS guard_enabled BOOLEAN NOT NULL DEFAULT true;

-- Drop and recreate get_or_create_settings (return type changed with new columns)
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

-- Drop and recreate update_settings (new params for approval_mode + guard_enabled)
DROP FUNCTION IF EXISTS update_settings(boolean, text);

CREATE OR REPLACE FUNCTION update_settings(
  p_auto_accept BOOLEAN DEFAULT NULL,
  p_default_model TEXT DEFAULT NULL,
  p_approval_mode TEXT DEFAULT NULL,
  p_guard_enabled BOOLEAN DEFAULT NULL
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
    auto_accept    = COALESCE(p_auto_accept, auto_accept),
    default_model  = COALESCE(p_default_model, default_model),
    approval_mode  = COALESCE(p_approval_mode, approval_mode),
    guard_enabled  = COALESCE(p_guard_enabled, guard_enabled),
    updated_at     = now()
  WHERE user_id = auth.uid();
END;
$$;
