/**
 * RFC 8414 Authorization Server Metadata
 * Path: /.well-known/oauth-authorization-server
 *
 * Returns OAuth metadata pointing to the proxy endpoints under /api/mcp/oauth/*.
 */

import { buildAuthServerMetadata } from "@/lib/mcp-oauth";

export async function GET(request: Request) {
  return Response.json(buildAuthServerMetadata(request), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
