-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 009: Orchestrations & Collaborative Agents
-- Tracks orchestration sessions, agent roles, and user collaboration settings
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Table: orchestrations ───────────────────────────────────────────────
-- Each orchestration session represents one collaborative task where an
-- orchestrator agent delegates work to one or more collaborator agents.

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
  œN public.orchestrations (user_id, status)
  WHERE status = 'active';

-- ── RLS: orchestrations ─────────────────────────────────────────────────
ALTER TABLE public.orchestrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own orchestrations"
  ON public.orchestrations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users manage own orchestrations"
  ON public.orchestrations FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── Alter user_clients: add agent role tracking ─────────────────────────
ALTER TABLE public.user_clients
  ADD COLUMN IF NOT EXISTS agent_role TEXT NOT NULL DEFAULT 'idle'
    CHECK (agent_role IN ('idle', 'orchestrator', 'collaborator'));

ALTER TABLE public.user_clients
  ADD COLUMN IF NOT EXISTS orchestration_id UUID
    REFERENCES public.orchestrations(id) ON DELETE SET NULL;

-- ── Table: user_settings ────────────────────────────────────────────────
-- Per-user collaboration preferences (auto-accept, etc.)

CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id     UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  auto_accept BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own settings"
  ON public.user_settings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users manage own settings"
  ON public.user_settings FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── RPC: create_orchestration ───────────────────────────────────────────
-- Creates an orchestration session and sets the caller's client as orchestrator.
-- Returns the orchestration ID.

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
  -- Verify the client belongs to the caller
  IF NOT EXISTS (
    SELECT 1 FROM user_clients
    WHERE user_id = v_uid AND client_id = p_client_id
  ) THEN
    RAISE EXCEPTION 'Client not found';
  END IF;

  -- Verify the client is idle (not already orchestrating or collaborating)
  IF EXISTS (
    SELECT 1 FROM user_clients
    WHERE user_id = v_uid AND client_id = p_client_id AND agent_role <> 'idle'
  ) THEN
    RAISE EXCEPTION 'Client already has an active role';
  END IF;

  -- Create the orchestration
  INSERT INTO orchestrations (user_id, orchestrator_client_id, conversation_id)
  VALUES (v_uid, p_client_id, p_conversation_id)
  RETURNING id INTO v_orch_id;

  -- Set the client as orchestrator
  UPDATE user_clients
  SET agent_role = 'orchestrator', orchestration_id = v_orch_id
  WHERE user_id = v_uid AND client_id = p_client_id;

  RETURN v_orch_id;
END;
$$;

-- ── RPC: join_orchestration ─────────────────────────────────────────────
-- A collaborator client joins an existing orchestration.

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
  -- Verify the orchestration exists and is active
  IF NOT EXISTS (
    SELECT 1 FROM orchestrations
    WHERE id = p_orchestration_id AND user_id = v_uid AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Orchestration not found or not active';
  END IF;

  -- Verify the client belongs to the caller and is idle
  IF NOT EXISTS (
    SELECT 1 FROM user_clients
    WHERE user_id = v_uid AND client_id = p_client_id AND agent_role = 'idle'
  ) THEN
    RAISE EXCEPTION 'Client not found or not idle';
  END IF;

  -- Set the client as collaborator
  UPDATE user_clients
  SET agent_role = 'collaborator', orchestration_id = p_orchestration_id
  WHERE user_id = v_uid AND client_id = p_client_id;
END;
$$;

-- ── RPC: complete_orchestration ─────────────────────────────────────────
-- Marks an orchestration as completed and releases all participant roles.

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
  -- Verify ownership and active status
  IF NOT EXISTS (
    SELECT 1 FROM orchestrations
    WHERE id = p_orchestration_id AND user_id = v_uid AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Orchestration not found or not active';
  END IF;

  -- Mark orchestration as completed/cancelled
  UPDATE orchestrations
  SET status = p_status, completed_at = now()
  WHERE id = p_orchestration_id;

  -- Release all participants back to idle
  UPDATE user_clients
  SET agent_role = 'idle', orchestration_id = NULL
  WHERE user_id = v_uid AND orchestration_id = p_orchestration_id;
END;
$$;

-- ── RPC: update_client_role ─────────────────────────────────────────────
-- Directly update a client's role (for edge cases and cleanup).

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

-- ── RPC: get_or_create_settings ─────────────────────────────────────────
-- Returns the user's settings, creating a default row if needed.

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

-- ── RPC: update_settings ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_settings(
  p_auto_accept BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  INSERT INTO user_settings (user_id, auto_accept, updated_at)
  VALUES (v_uid, p_auto_accept, now())
  ON CONFLICT (user_id) DO UPDATE
  SET auto_accept = p_auto_accept, updated_at = now();
END;
$$;

-- ── Add FK for conversations.orchestration_id ───────────────────────────
-- (conversations table is created in migration 008; this adds the FK constraint)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'conversations_orchestration_id_fkey'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_orchestration_id_fkey
      FOREIGN KEY (orchestration_id)
      REFERENCES public.orchestrations(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;
