-- Enable RLS on model_pricing_cache to fix security alert.
-- This table is only accessed via the service-role client (which bypasses RLS),
-- so no policies are needed — RLS with no policies blocks all access via anon/authenticated keys.
ALTER TABLE public.model_pricing_cache ENABLE ROW LEVEL SECURITY;