-- Per-model configuration for the Guardian orchestration engine.
-- Used by the Temporal worker to customize behavior per AI model.
-- No RLS needed — system config table, read by service-role only.

CREATE TABLE IF NOT EXISTS public.guardian_model_config (
  model_id         TEXT        PRIMARY KEY,
  metadata_format  TEXT        NOT NULL DEFAULT 'xml' CHECK (metadata_format IN ('xml', 'bracket')),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.guardian_model_config IS 'Per-model config for the Guardian orchestration engine (message format, etc.)';
COMMENT ON COLUMN public.guardian_model_config.metadata_format IS 'How to wrap injected messages: xml (default) = XML tags, bracket = [from: ... | to: ...] prefix';
