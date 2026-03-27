/**
 * RFC 9728 Protected Resource Metadata
 * Path: /.well-known/oauth-protected-resource/api/mcp
 *
 * The MCP SDK discovers this first by appending the MCP server path (/api/mcp)
 * to /.well-known/oauth-protected-resource.
 */

import { buildProtectedResourceMetadata } from "@/lib/mcp-oauth";

export async function GET(request: Request) {
  return Response.json(buildProtectedResourceMetadata(request), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
