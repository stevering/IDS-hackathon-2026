-- Fix: don't bump updated_at when only is_active changes.
-- This prevents conversation reordering when switching active conversation.

CREATE OR REPLACE FUNCTION public.update_conversation_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only bump updated_at for content changes, not is_active toggling
  IF OLD.is_active IS DISTINCT FROM NEW.is_active
     AND OLD.title = NEW.title
     AND OLD.metadata::text = NEW.metadata::text
  THEN
    NEW.updated_at = OLD.updated_at;
  ELSE
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;
