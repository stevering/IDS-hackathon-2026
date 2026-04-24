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
// CORS headers — restrict to known browser origins; non-browser MCP clients
// (Claude Desktop, VS Code, curl) don't send an Origin header and get "*".
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set(
  [process.env.NEXT_PUBLIC_BASE_URL, "http://localhost:3000", "http://127.0.0.1:3000"]
    .filter(Boolean) as string[]
);

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const base: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, mcp-protocol-version",
    "Access-Control-Max-Age": "86400",
  };
  if (!origin) {
    // Non-browser MCP client — no CORS restriction needed
    base["Access-Control-Allow-Origin"] = "*";
  } else if (ALLOWED_ORIGINS.has(origin)) {
    base["Access-Control-Allow-Origin"] = origin;
    base["Vary"] = "Origin";
  } else {
    // Unknown browser origin — deny cross-origin access
    base["Access-Control-Allow-Origin"] = "null";
    base["Vary"] = "Origin";
  }
  return base;
}

function addCorsHeaders(request: Request, response: Response): Response {
  const corsHeaders = getCorsHeaders(request);
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders)) {
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

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: getCorsHeaders(request) });
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

    // Return 401 with OAuth discovery hint when no valid token is provided
    if (!userId) {
      const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "localhost";
      const proto = request.headers.get("x-forwarded-proto") ?? "https";
      const resourceUrl = `${proto}://${host}/api/mcp`;
      return Response.json(
        { error: "Unauthorized", message: "Valid Bearer token required." },
        {
          status: 401,
          headers: {
            ...getCorsHeaders(request),
            "WWW-Authenticate": `Bearer resource_metadata="${resourceUrl}"`,
          },
        },
      );
    }

    // Create a fresh stateless MCP server + transport
    const server = createGuardianServer(userId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session persistence
    });

    await server.connect(transport);

    // Let the transport handle the request natively (Web Standard Request → Response)
    const response = await transport.handleRequest(request);

    return addCorsHeaders(request, response);
  } catch (error) {
    console.error("[MCP Route] Error:", error instanceof Error ? error.message : error);
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Internal MCP server error" }, id: null },
      { status: 500, headers: getCorsHeaders(request) }
    );
  }
}
