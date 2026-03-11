import { createClient } from "@supabase/supabase-js"

/**
 * Supabase client for the MCP server — uses service-role key (bypasses RLS).
 * Server-side only. Used for Realtime channels (broadcast, presence).
 */
export function createMcpSupabaseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_URL!,
    process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}
