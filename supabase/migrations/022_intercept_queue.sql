-- Intercept queue: persistent storage for delegated LLM calls.
-- Used by the interceptor (Temporal activity) and responders (Claude Code, MCP tools, UI).

CREATE TABLE intercept_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT UNIQUE NOT NULL,

  -- Who
  user_id UUID NOT NULL REFERENCES auth.users(id),

  -- Where (context)
  conversation_type TEXT,
  conversation_id TEXT,
  orchestration_id TEXT,
  agent_short_id TEXT,
  agent_workflow_id TEXT,
  agent_type TEXT,
  agent_label TEXT,
  agent_file_name TEXT,

  -- What
  purpose TEXT NOT NULL,
  model TEXT,
  current_directive TEXT,
  step_count INTEGER,
  exec_stats JSONB,

  -- Request
  status TEXT NOT NULL DEFAULT 'pending',
  request_payload JSONB NOT NULL,

  -- Response
  response_content TEXT,
  response_tool_calls JSONB,
  responded_by TEXT,

  -- Outcome (filled after execution, for analytics)
  execution_success BOOLEAN,
  execution_error TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ
);

-- Fast lookup for pending intercepts per user
CREATE INDEX idx_intercept_queue_pending
  ON intercept_queue (user_id, status, created_at)
  WHERE status = 'pending';

-- Lookup by orchestration (for post-mortem analysis)
CREATE INDEX idx_intercept_queue_orch
  ON intercept_queue (orchestration_id, created_at);

-- RLS: users can only see/update their own rows
ALTER TABLE intercept_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY intercept_queue_user_policy ON intercept_queue
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
