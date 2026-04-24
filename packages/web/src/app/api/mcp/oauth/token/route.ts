/**
 * OAuth Token Endpoint (proxy to Supabase)
 * Path: /api/mcp/oauth/token
 *
 * Claude Code exchanges the authorization code for an access token here.
 */

import { proxyToSupabaseOAuth, corsOptions } from "@/lib/mcp-oauth";

export async function POST(request: Request) {
  return proxyToSupabaseOAuth(request, "/token");
}

export async function OPTIONS(request: Request) {
  return corsOptions(request);
}
