-- ═══════════════════════════════════════════════════════════════════════════
-- 024 — MCP Connections (OAuth tokens for MCP servers, stored in Vault)
--
-- Allows Temporal workers to retrieve user-authorized MCP tokens
-- without relying on browser cookies.
-- Pattern follows user_api_keys (001_init.sql §5).
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  1. TABLE                                                               ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.user_mcp_connections (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  server_id   TEXT        NOT NULL,          -- e.g. "figma_console", "github"
  vault_id    UUID        NOT NULL,          -- → vault.secrets (encrypted tokens JSON)
  scopes      TEXT,                          -- space/comma-separated OAuth scopes granted
  expires_at  TIMESTAMPTZ,                   -- access_token expiry (for proactive refresh)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, server_id)
);

ALTER TABLE public.user_mcp_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own mcp connections"
  ON public.user_mcp_connections FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users insert own mcp connections"
  ON public.user_mcp_connections FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own mcp connections"
  ON public.user_mcp_connections FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own mcp connections"
  ON public.user_mcp_connections FOR DELETE USING (auth.uid() = user_id);


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  2. RPC FUNCTIONS (SECURITY DEFINER)                                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝


-- ── upsert_mcp_connection (authenticated user) ─────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_mcp_connection(
  p_server_id   TEXT,
  p_tokens_json TEXT,
  p_scopes      TEXT    DEFAULT NULL,
  p_expires_at  TIMESTAMPTZ DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_vault_id UUID;
  v_existing UUID;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT vault_id INTO v_existing
  FROM public.user_mcp_connections
  WHERE user_id = v_user_id AND server_id = p_server_id;

  IF v_existing IS NOT NULL THEN
    -- Update existing secret in Vault
    PERFORM vault.update_secret(v_existing, p_tokens_json);
    UPDATE public.user_mcp_connections
      SET scopes     = COALESCE(p_scopes, scopes),
          expires_at = p_expires_at,
          updated_at = now()
      WHERE user_id = v_user_id AND server_id = p_server_id;
  ELSE
    -- Create new secret in Vault
    v_vault_id := vault.create_secret(
      p_tokens_json,
      'mcp_' || p_server_id || '_' || v_user_id::text
    );
    INSERT INTO public.user_mcp_connections (user_id, server_id, vault_id, scopes, expires_at)
      VALUES (v_user_id, p_server_id, v_vault_id, p_scopes, p_expires_at);
  END IF;
END; $$;


-- ── get_mcp_connection (authenticated user) ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_mcp_connection(p_server_id TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_vault_id UUID;
  v_secret   TEXT;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT vault_id INTO v_vault_id
  FROM public.user_mcp_connections
  WHERE user_id = v_user_id AND server_id = p_server_id;
  IF v_vault_id IS NULL THEN RETURN NULL; END IF;
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE id = v_vault_id;
  RETURN v_secret;
END; $$;


-- ── get_mcp_connection_service (service-role, for Temporal workers) ──────────

CREATE OR REPLACE FUNCTION public.get_mcp_connection_service(
  p_user_id   UUID,
  p_server_id TEXT
)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vault_id UUID;
  v_secret   TEXT;
BEGIN
  SELECT vault_id INTO v_vault_id
  FROM public.user_mcp_connections
  WHERE user_id = p_user_id AND server_id = p_server_id;
  IF v_vault_id IS NULL THEN RETURN NULL; END IF;
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE id = v_vault_id;
  RETURN v_secret;
END; $$;


-- ── delete_mcp_connection (authenticated user) ──────────────────────────────

CREATE OR REPLACE FUNCTION public.delete_mcp_connection(p_server_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_vault_id UUID;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT vault_id INTO v_vault_id
  FROM public.user_mcp_connections
  WHERE user_id = v_user_id AND server_id = p_server_id;
  IF v_vault_id IS NOT NULL THEN
    DELETE FROM public.user_mcp_connections
      WHERE user_id = v_user_id AND server_id = p_server_id;
    DELETE FROM vault.secrets WHERE id = v_vault_id;
  END IF;
END; $$;


-- ── list_mcp_connections_service (service-role, no secrets) ──────────────────

CREATE OR REPLACE FUNCTION public.list_mcp_connections_service(p_user_id UUID)
RETURNS TABLE(server_id TEXT, scopes TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  SELECT mc.server_id, mc.scopes, mc.expires_at
  FROM public.user_mcp_connections mc
  WHERE mc.user_id = p_user_id;
END; $$;
