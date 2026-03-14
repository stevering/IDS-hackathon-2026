-- Debug traces: persistent per-client event logs keyed by conversation_id.
-- Each client (webapp, figma-plugin) pushes its own trace; the API merges them
-- into a unified debug report on read.

CREATE TABLE IF NOT EXISTS public.debug_traces (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id  UUID        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  source_client_id TEXT        NOT NULL,
  source_short_id  TEXT,
  client_type      TEXT,        -- "webapp" | "figma-plugin" | future types
  events           JSONB       NOT NULL DEFAULT '[]',
  client_state     JSONB       NOT NULL DEFAULT '{}',
  pushed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, source_client_id)
);

CREATE INDEX idx_debug_traces_conv ON public.debug_traces (conversation_id);
CREATE INDEX idx_debug_traces_user ON public.debug_traces (user_id, pushed_at DESC);

ALTER TABLE public.debug_traces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own traces"
  ON public.debug_traces FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "users manage own traces"
  ON public.debug_traces FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Cleanup: 7-day TTL
CREATE OR REPLACE FUNCTION public.cleanup_old_debug_traces()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted INTEGER;
BEGIN
  DELETE FROM public.debug_traces WHERE pushed_at < now() - interval '7 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END; $$;
