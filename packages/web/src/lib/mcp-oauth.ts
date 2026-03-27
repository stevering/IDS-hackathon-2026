/**
 * OAuth 2.1 helpers for the Guardian MCP server (Vercel / Next.js API routes).
 *
 * Adapts the logic from packages/mcp/src/auth.ts (Node.js standalone)
 * to Web Standard Request/Response for use in Next.js route handlers.
 *
 * Strategy: proxy OAuth endpoints to Supabase Auth, injecting the `apikey` header.
 * Supabase handles all the heavy lifting (PKCE, code exchange, token issuance, DCR).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getSupabaseUrl(): string {
  const url =
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_URL ??
    process.env.SUPABASE_URL;
  if (!url) throw new Error("[MCP OAuth] SUPABASE_URL not set");
  return url.replace(/\/+$/, "");
}

function getSupabaseAnonKey(): string {
  const key =
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY;
  if (!key) throw new Error("[MCP OAuth] SUPABASE_ANON_KEY not set");
  return key;
}

function getBaseUrl(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://localhost:3000";
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export function corsOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function addCors(headers: Record<string, string>): Record<string, string> {
  return { ...headers, ...CORS_HEADERS };
}

// ---------------------------------------------------------------------------
// OAuth metadata
// ---------------------------------------------------------------------------

export function buildProtectedResourceMetadata(request: Request): Record<string, unknown> {
  const base = getBaseUrl(request);
  return {
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
  };
}

export function buildAuthServerMetadata(request: Request): Record<string, unknown> {
  const base = getBaseUrl(request);
  const supabaseBase = `${getSupabaseUrl()}/auth/v1`;
  return {
    issuer: supabaseBase,
    authorization_endpoint: `${base}/api/mcp/oauth/authorize`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    registration_endpoint: `${base}/api/mcp/oauth/register`,
    jwks_uri: `${supabaseBase}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "email", "profile", "phone"],
  };
}

// ---------------------------------------------------------------------------
// OAuth proxy to Supabase
// ---------------------------------------------------------------------------

/**
 * Proxy an OAuth request to Supabase, injecting the `apikey` header.
 * Works for GET (authorize) and POST (token, register).
 */
export async function proxyToSupabaseOAuth(
  request: Request,
  supabasePath: string,
): Promise<Response> {
  const supabaseTarget = `${getSupabaseUrl()}/auth/v1/oauth${supabasePath}`;
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(supabaseTarget);

  // Forward query params
  incomingUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  const headers: Record<string, string> = {
    apikey: getSupabaseAnonKey(),
  };

  const contentType = request.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;
  const authorization = request.headers.get("authorization");
  if (authorization) headers["Authorization"] = authorization;

  let body: string | undefined;
  if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
    body = await request.text();
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (!["transfer-encoding", "connection", "content-encoding"].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    const responseBody = await response.text();

    return new Response(responseBody, {
      status: response.status,
      headers: addCors(responseHeaders),
    });
  } catch (err) {
    console.error("[MCP OAuth] Proxy error:", err instanceof Error ? err.message : String(err));
    return Response.json(
      { error: "OAuth proxy error" },
      { status: 502, headers: CORS_HEADERS },
    );
  }
}
