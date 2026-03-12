/**
 * Stateless MCP API route — serves the Guardian MCP server as a Next.js API route.
 *
 * When GUARDIAN_MCP_URL is not set (e.g. on Vercel), the chat route auto-detects
 * this endpoint. Each request creates a fresh McpServer (stateless), handles the
 * JSON-RPC message, and tears down — compatible with serverless functions.
 *
 * Uses WebStandardStreamableHTTPServerTransport which works natively with
 * Web Standard Request/Response — no Node.js adapter layer needed.
 *
 * In local dev with GUARDIAN_MCP_URL pointing to the standalone process (port 3847),
 * this route is never called.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createGuardianServer } from "@guardian/mcp-server/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Auth — extract userId from Bearer token via Supabase
// ---------------------------------------------------------------------------

async function extractUserId(request: Request): Promise<string | undefined> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return undefined;

  const token = authHeader.slice(7);
  if (!token) return undefined;

  // Use Supabase client to verify the token and extract user
  const { createClient } = await import("@supabase/supabase-js");
  const supabaseUrl = process.env.NEXT_PUBLIC_STORAGE_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return undefined;

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const { data: { user } } = await supabase.auth.getUser(token);
  return user?.id;
}

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, mcp-protocol-version",
  "Access-Control-Max-Age": "86400",
};

function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: Request) {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request) {
  return handleMcpRequest(request);
}

export async function POST(request: Request) {
  return handleMcpRequest(request);
}

async function handleMcpRequest(request: Request): Promise<Response> {
  try {
    // Authenticate and extract userId
    const userId = await extractUserId(request);

    // Create a fresh stateless MCP server + transport
    const server = createGuardianServer(userId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session persistence
    });

    await server.connect(transport);

    // Let the transport handle the request natively (Web Standard Request → Response)
    const response = await transport.handleRequest(request);

    return addCorsHeaders(response);
  } catch (error) {
    console.error("[MCP Route] Error:", error instanceof Error ? error.message : error);
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Internal MCP server error" }, id: null },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
