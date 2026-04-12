-- ═══════════════════════════════════════════════════════════════════════════
-- 033 — Add dismissed flag to user_mcp_instances
--
-- When the Desktop Companion discovers a local service (e.g. Figma Desktop
-- on port 3845), the webapp shows it as "DISCOVERED". The user can:
--   - Enable → creates a row with enabled=true, dismissed=false
--   - Ignore → creates a row with enabled=false, dismissed=true
--
-- This flag distinguishes "user actively disabled" (enabled=false, dismissed=false)
-- from "user chose to ignore this discovered service" (enabled=false, dismissed=true).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_mcp_instances
  ADD COLUMN IF NOT EXISTS dismissed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.user_mcp_instances.dismissed IS
  'True if the user explicitly ignored this discovered service. '
  'Ignored services are hidden by default in the UI. '
  'Only meaningful when enabled=false.';
