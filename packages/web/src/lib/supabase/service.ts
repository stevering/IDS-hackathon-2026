import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client with service-role key — bypasses RLS.
 * Server-side only. Never expose to the client.
 *
 * Used for:
 *  - increment_usage (called from chat route, no user auth context needed)
 *  - get_api_key on behalf of an authenticated user (chat route)
 */
export function createServiceClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
