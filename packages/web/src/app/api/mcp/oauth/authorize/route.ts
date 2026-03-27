/**
 * OAuth Authorization Endpoint (proxy to Supabase)
 * Path: /api/mcp/oauth/authorize
 *
 * Claude Code redirects the user here with standard OAuth params.
 * We proxy to Supabase which handles the login flow and redirects back.
 */

import { proxyToSupabaseOAuth, corsOptions } from "@/lib/mcp-oauth";

export async function GET(request: Request) {
  return proxyToSupabaseOAuth(request, "/authorize");
}

export async function OPTIONS() {
  return corsOptions();
}
