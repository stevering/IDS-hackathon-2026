/**
 * OAuth Dynamic Client Registration (proxy to Supabase)
 * Path: /api/mcp/oauth/register
 *
 * Claude Code registers itself as an OAuth client dynamically.
 */

import { proxyToSupabaseOAuth, corsOptions } from "@/lib/mcp-oauth";

export async function POST(request: Request) {
  return proxyToSupabaseOAuth(request, "/clients/register");
}

export async function OPTIONS() {
  return corsOptions();
}
