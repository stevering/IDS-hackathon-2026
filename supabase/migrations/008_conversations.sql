-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 008: Conversation & message persistence
-- Stores chat conversations and messages for the webapp/plugin instances.
-- Prerequisite for Collaborative Agents mode (multi-conversation support).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Table: conversations ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.conversations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id        TEXT,                       -- webapp/plugin that created the conversation
  title            TEXT        NOT NULL DEFAULT 'New conversation',
  is_active        BOOLEAN     NOT NULL DEFAULT FALSE,
  parent_id        UUID        REFERENCES public.conversations(id) ON DELETE SET NULL,
  orchestration_id UUID,                       -- NULL if standalone; set when part of an orchestration
  metadata         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user
  ON public.conversations (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_client
  ON public.conversations (user_id, client_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_conversations_orchestration
  ON public.conversations (orchestration_id)
  WHERE orchestration_id IS NOT NULL;

-- ── Table: messages ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.messages (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role             TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'agent')),
  content          TEXT        NOT NULL,
  parts            JSONB,                      -- structured parts from ai-sdk (tool calls, thinking blocks, etc.)
  sender_client_id TEXT,
  sender_short_id  TEXT,
  metadata         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON public.messages (conversation_id, created_at ASC);

-- ── RLS ─────────────────────────────────────────────────────────────────

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own conversations"
  ON public.conversations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users manage own conversations"
  ON public.conversations FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own messages"
  ON public.messages FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id AND c.user_id = auth.uid()
  ));

CREATE POLICY "users insert own messages"
  ON public.messages FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id AND c.user_id = auth.uid()
  ));

CREATE POLICY "users delete own messages"
  ON public.messages FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id AND c.user_id = auth.uid()
  ));

-- ── Trigger: auto-update updated_at on conversations ────────────────────

CREATE OR REPLACE FUNCTION public.update_conversation_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_conversation_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_conversation_timestamp();

-- ── RPC: create_conversation ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_conversation(
  p_client_id        TEXT    DEFAULT NULL,
  p_title            TEXT    DEFAULT 'New conversation',
  p_parent_id        UUID   DEFAULT NULL,
  p_orchestration_id UUID   DEFAULT NULL,
  p_metadata         JSONB  DEFAULT '{}'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  INSERT INTO conversations (user_id, client_id, title, parent_id, orchestration_id, metadata)
  VALUES (v_uid, p_client_id, p_title, p_parent_id, p_orchestration_id, p_metadata)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── RPC: set_active_conversation ────────────────────────────────────────
-- Sets a conversation as active for a given client; deactivates others.

CREATE OR REPLACE FUNCTION public.set_active_conversation(
  p_conversation_id UUID,
  p_client_id       TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  -- Deactivate other active conversations for this client
  IF p_client_id IS NOT NULL THEN
    UPDATE conversations
    SET is_active = FALSE
    WHERE user_id = v_uid AND client_id = p_client_id AND is_active = TRUE AND id <> p_conversation_id;
  ELSE
    UPDATE conversations
    SET is_active = FALSE
    WHERE user_id = v_uid AND is_active = TRUE AND id <> p_conversation_id;
  END IF;

  -- Activate the target conversation
  UPDATE conversations
  SET is_active = TRUE
  WHERE id = p_conversation_id AND user_id = v_uid;
END;
$$;

-- ── RPC: save_message ───────────────────────────────────────────────────
-- Inserts a message and bumps the conversation's updated_at.

CREATE OR REPLACE FUNCTION public.save_message(
  p_conversation_id UUID,
  p_role            TEXT,
  p_content         TEXT,
  p_parts           JSONB  DEFAULT NULL,
  p_sender_client_id TEXT  DEFAULT NULL,
  p_sender_short_id  TEXT  DEFAULT NULL,
  p_metadata        JSONB  DEFAULT '{}'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  -- Verify conversation ownership
  IF NOT EXISTS (
    SELECT 1 FROM conversations WHERE id = p_conversation_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  INSERT INTO messages (conversation_id, role, content, parts, sender_client_id, sender_short_id, metadata)
  VALUES (p_conversation_id, p_role, p_content, p_parts, p_sender_client_id, p_sender_short_id, p_metadata)
  RETURNING id INTO v_id;

  -- Bump conversation updated_at (trigger handles this via UPDATE)
  UPDATE conversations SET title = title WHERE id = p_conversation_id;

  RETURN v_id;
END;
$$;
