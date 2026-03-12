-- Drop dead function overloads left over from old migrations.
--
-- 1. increment_usage(uuid) — from migration 002, references the deleted user_usage table
-- 2. update_settings(boolean) — from migration 009, replaced by the 2-param version in 010

DROP FUNCTION IF EXISTS public.increment_usage(uuid);
DROP FUNCTION IF EXISTS public.update_settings(boolean);
