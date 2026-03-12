/**
 * Stateless MCP API route — serves the Guardian MCP server as a Next.js API route.
 *
 * When GUARDIAN_MCP_URL is not set (e.g. on Vercel), the chat route auto-detects
 * this endpoint. Each request creates a fresh McpServer (stateless), handles the
 * JSON-RPC message, and tears down — compatible with serverless functions.
 *
 * In local dev with GUARDIAN_MCP_URL pointing to the standalone process (port 3847),
 * this route is never called.
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createGuardianServer } from "@guardian/mcp-server/server";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

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
// Node.js adapters — bridge Web Request/Response ↔ IncomingMessage/ServerResponse
// ---------------------------------------------------------------------------

function toNodeIncomingMessage(request: Request): IncomingMessage {
  const url = new URL(request.url);
  const socket = new Socket();
  const msg = new IncomingMessage(socket);
  msg.method = request.method;
  msg.url = url.pathname + url.search;

  // Copy headers from Web Request
  request.headers.forEach((value, key) => {
    msg.headers[key.toLowerCase()] = value;
  });

  // Ensure Accept header satisfies StreamableHTTPServerTransport requirements
  // (needs both application/json AND text/event-stream)
  const accept = msg.headers["accept"] as string | undefined;
  if (!accept || !accept.includes("text/event-stream")) {
    msg.headers["accept"] = "application/json, text/event-stream";
  }

  return msg;
}

function createResponseCapture(): {
  nodeRes: ServerResponse;
  getWebResponse: () => Promise<Response>;
} {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];

  let resolvePromise: (response: Response) => void;
  const responsePromise = new Promise<Response>((resolve) => {
    resolvePromise = resolve;
  });

  // Create a real ServerResponse attached to a dummy socket
  const socket = new Socket();
  const dummyReq = new IncomingMessage(socket);
  const nodeRes = new ServerResponse(dummyReq);

  // Intercept writeHead to capture status + headers
  const origWriteHead = nodeRes.writeHead.bind(nodeRes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodeRes.writeHead = function (code: number, ...args: any[]) {
    statusCode = code;
    // writeHead can be called as (code, headers) or (code, statusMessage, headers)
    const headersArg = args.length === 1 ? args[0] : args[1];
    if (headersArg && typeof headersArg === "object") {
      for (const [k, v] of Object.entries(headersArg)) {
        if (v !== undefined) headers[k] = String(v);
      }
    }
    return origWriteHead(code, ...args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // Intercept setHeader
  const origSetHeader = nodeRes.setHeader.bind(nodeRes);
  nodeRes.setHeader = function (name: string, value: string | number | readonly string[]) {
    headers[name.toLowerCase()] = String(value);
    return origSetHeader(name, value);
  };

  // Intercept write to capture body chunks
  const origWrite = nodeRes.write.bind(nodeRes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodeRes.write = function (chunk: any, ...args: any[]) {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return origWrite(chunk, ...(args as [any]));
  } as typeof nodeRes.write;

  // Intercept end to finalize and resolve the Web Response
  const origEnd = nodeRes.end.bind(nodeRes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodeRes.end = function (chunk?: any, ...args: any[]) {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const body = Buffer.concat(chunks);
    resolvePromise(
      new Response(body.length > 0 ? body : null, {
        status: statusCode,
        headers,
      })
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return origEnd(chunk, ...(args as [any]));
  } as typeof nodeRes.end;

  return { nodeRes, getWebResponse: () => responsePromise };
}

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  // SSE streams are not supported in stateless mode.
  // Return 405 with proper MCP error format so clients handle it gracefully.
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "SSE not supported in stateless mode" } }),
    { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
}

export async function DELETE() {
  // No sessions to close in stateless mode
  return Response.json(
    { error: "Session management not available in stateless mode." },
    { status: 405, headers: CORS_HEADERS }
  );
}

export async function POST(request: Request) {
  try {
    // Authenticate and extract userId
    const userId = await extractUserId(request);

    // Parse JSON-RPC body
    const body = await request.json();

    // Create a fresh stateless MCP server
    const server = createGuardianServer(userId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session persistence
    });

    await server.connect(transport);

    // Adapt Web Request → Node.js objects
    const nodeReq = toNodeIncomingMessage(request);
    const { nodeRes, getWebResponse } = createResponseCapture();

    // Handle the MCP request
    await transport.handleRequest(nodeReq, nodeRes, body);

    // Convert captured Node response → Web Response
    const webResponse = await getWebResponse();

    // Merge CORS headers
    const finalHeaders = new Headers(webResponse.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      finalHeaders.set(k, v);
    }

    return new Response(webResponse.body, {
      status: webResponse.status,
      headers: finalHeaders,
    });
  } catch (error) {
    console.error("[MCP Route] Error:", error instanceof Error ? error.message : error);
    return Response.json(
      { error: "Internal MCP server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
