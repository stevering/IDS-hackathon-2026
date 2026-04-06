-- ═══════════════════════════════════════════════════════════════════════════
-- 032 — MCP instances, devices, and category defaults
--
-- Replaces the hardcoded MCP_SERVERS registry with a per-user, multi-instance
-- model. Enables multi-machine (devices) and multi-account (labels) scenarios.
--
-- The existing user_mcp_connections table (migration 024) is preserved — it
-- still holds OAuth tokens in Vault for cloud instances. user_mcp_instances
-- joins to it via (user_id, connection_server_id).
--
-- Tables:
--   user_devices            — registered Guardian overlay machines
--   user_mcp_instances      — all MCP instances configured by the user
--   user_category_defaults  — primary instance per category (design / code)
--
-- RPCs (service-role, for Temporal workers):
--   list_mcp_instances_service
--   get_category_defaults_service
--   touch_device_last_seen (authenticated user, called by overlay heartbeat)
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  1. user_devices                                                          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.user_devices (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_fingerprint TEXT        NOT NULL,
  device_name        TEXT        NOT NULL,
  os_info            TEXT,
  overlay_version    TEXT,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user_last_seen
  ON public.user_devices (user_id, last_seen_at DESC);

ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users select own devices" ON public.user_devices;
CREATE POLICY "users select own devices"
  ON public.user_devices FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users insert own devices" ON public.user_devices;
CREATE POLICY "users insert own devices"
  ON public.user_devices FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users update own devices" ON public.user_devices;
CREATE POLICY "users update own devices"
  ON public.user_devices FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users delete own devices" ON public.user_devices;
CREATE POLICY "users delete own devices"
  ON public.user_devices FOR DELETE USING (auth.uid() = user_id);


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  2. user_mcp_instances                                                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.user_mcp_instances (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Preset identity (resolved against code constants in @guardian/orchestrations)
  preset_type           TEXT        NOT NULL,
  category              TEXT        NOT NULL CHECK (category IN ('design', 'code')),
  scope                 TEXT        NOT NULL CHECK (scope IN ('cloud', 'local')),

  -- User-editable identity (unique per user, slug-safe, used in tool name prefix)
  label                 TEXT        NOT NULL CHECK (label ~ '^[a-z0-9_]+$'),
  display_name          TEXT,

  -- Location (required for local, NULL for cloud)
  device_id             UUID REFERENCES public.user_devices(id) ON DELETE CASCADE,

  -- Transport-specific config. Shape depends on preset_type + scope:
  --   cloud                → {}  (URL comes from preset constant)
  --   local http/sse       → {"url": "http://127.0.0.1:3846/sse"}
  --   local stdio          → {}  (command/args from preset constant)
  config                JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Link to user_mcp_connections for OAuth-backed instances.
  -- For cloud: matches user_mcp_connections.server_id.
  -- For local: always NULL (no OAuth).
  connection_server_id  TEXT,

  enabled               BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, label),
  CONSTRAINT scope_device_consistency CHECK (
    (scope = 'cloud' AND device_id IS NULL)
    OR (scope = 'local' AND device_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_user_mcp_instances_user_enabled
  ON public.user_mcp_instances (user_id, enabled);

CREATE INDEX IF NOT EXISTS idx_user_mcp_instances_device
  ON public.user_mcp_instances (device_id)
  WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_mcp_instances_connection
  ON public.user_mcp_instances (user_id, connection_server_id)
  WHERE connection_server_id IS NOT NULL;

ALTER TABLE public.user_mcp_instances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users select own mcp instances" ON public.user_mcp_instances;
CREATE POLICY "users select own mcp instances"
  ON public.user_mcp_instances FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users insert own mcp instances" ON public.user_mcp_instances;
CREATE POLICY "users insert own mcp instances"
  ON public.user_mcp_instances FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users update own mcp instances" ON public.user_mcp_instances;
CREATE POLICY "users update own mcp instances"
  ON public.user_mcp_instances FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users delete own mcp instances" ON public.user_mcp_instances;
CREATE POLICY "users delete own mcp instances"
  ON public.user_mcp_instances FOR DELETE USING (auth.uid() = user_id);


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  3. user_category_defaults                                                ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.user_category_defaults (
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category    TEXT        NOT NULL CHECK (category IN ('design', 'code')),
  instance_id UUID        REFERENCES public.user_mcp_instances(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

ALTER TABLE public.user_category_defaults ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users manage own category defaults" ON public.user_category_defaults;
CREATE POLICY "users manage own category defaults"
  ON public.user_category_defaults FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  4. RPC: list_mcp_instances_service                                       ║
-- ║     (service-role, used by Temporal workers to discover user instances)  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION public.list_mcp_instances_service(p_user_id UUID)
RETURNS TABLE (
  id                   UUID,
  preset_type          TEXT,
  category             TEXT,
  scope                TEXT,
  label                TEXT,
  display_name         TEXT,
  device_id            UUID,
  device_name          TEXT,
  device_last_seen_at  TIMESTAMPTZ,
  config               JSONB,
  connection_server_id TEXT,
  enabled              BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
    SELECT
      i.id,
      i.preset_type,
      i.category,
      i.scope,
      i.label,
      i.display_name,
      i.device_id,
      d.device_name,
      d.last_seen_at AS device_last_seen_at,
      i.config,
      i.connection_server_id,
      i.enabled
    FROM public.user_mcp_instances i
    LEFT JOIN public.user_devices d ON d.id = i.device_id
    WHERE i.user_id = p_user_id
      AND i.enabled = TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.list_mcp_instances_service(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_mcp_instances_service(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.list_mcp_instances_service(UUID) TO service_role;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  5. RPC: get_category_defaults_service                                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION public.get_category_defaults_service(p_user_id UUID)
RETURNS TABLE (category TEXT, instance_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
    SELECT d.category, d.instance_id
    FROM public.user_category_defaults d
    WHERE d.user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_category_defaults_service(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_category_defaults_service(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_category_defaults_service(UUID) TO service_role;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  6. RPC: touch_device_last_seen                                           ║
-- ║     (authenticated user, called by overlay heartbeat)                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION public.touch_device_last_seen(p_device_fingerprint TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE public.user_devices
    SET last_seen_at = now()
    WHERE user_id = v_user_id
      AND device_fingerprint = p_device_fingerprint;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_device_last_seen(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_device_last_seen(TEXT) TO authenticated;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  7. Account deletion hook — extend cleanup_user_vault_secrets             ║
-- ║                                                                            ║
-- ║  user_mcp_instances has no direct vault link (tokens live in              ║
-- ║  user_mcp_connections, already cleaned up). user_devices and              ║
-- ║  user_category_defaults cascade via FK. No extra cleanup needed here.    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- (intentionally no change to cleanup_user_vault_secrets)
