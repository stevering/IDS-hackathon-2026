/**
 * OAuth 2.1 authentication for Guardian MCP Server
 *
 * - Proxies OAuth endpoints (register, authorize, token) to Supabase Auth,
 *   injecting the required `apikey` header that Supabase demands.
 * - Serves /.well-known/oauth-authorization-server metadata pointing to local proxies.
 * - Validates Bearer JWT tokens on /mcp requests using Supabase JWKS public keys.
 *
 * Environment variables:
 *   SUPABASE_URL              — e.g. https://<project>.supabase.co (required in HTTP mode)
 *   SUPABASE_ANON_KEY         — Supabase anon key (required for OAuth proxy)
 *   NEXT_PUBLIC_STORAGE_SUPABASE_URL  — fallback for SUPABASE_URL
 *   NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY — fallback for SUPABASE_ANON_KEY
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"
import type { IncomingMessage, ServerResponse } from "node:http"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Local webapp URL — used to rewrite Supabase consent redirects in dev */
function getWebappUrl(): string | undefined {
  return process.env.GUARDIAN_WEBAPP_URL
}

function getSupabaseUrl(): string {
  const url =
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_URL
  if (!url) {
    throw new Error(
      "[Guardian MCP] SUPABASE_URL or NEXT_PUBLIC_STORAGE_SUPABASE_URL must be set in HTTP mode."
    )
  }
  return url.replace(/\/+$/, "")
}

function getSupabaseAnonKey(): string {
  const key =
    process.env.SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY
  if (!key) {
    throw new Error(
      "[Guardian MCP] SUPABASE_ANON_KEY or NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY must be set in HTTP mode."
    )
  }
  return key
}

// Lazy-initialised JWKS fetcher (caches keys automatically)
let _jwks: ReturnType<typeof createRemoteJWKSet> | undefined

function getJWKS(): ReturnType<typeof createRemoteJWKSet> {
  if (!_jwks) {
    const url = `${getSupabaseUrl()}/auth/v1/.well-known/jwks.json`
    _jwks = createRemoteJWKSet(new URL(url))
    console.error(`[Guardian MCP] JWKS endpoint: ${url}`)
  }
  return _jwks
}

// ---------------------------------------------------------------------------
// OAuth metadata (discovery) — points to LOCAL proxy endpoints
// ---------------------------------------------------------------------------

export function buildOAuthMetadata(localOrigin: string): Record<string, unknown> {
  const supabaseBase = `${getSupabaseUrl()}/auth/v1`
  return {
    issuer: supabaseBase,
    authorization_endpoint: `${localOrigin}/oauth/authorize`,
    token_endpoint: `${localOrigin}/oauth/token`,
    registration_endpoint: `${localOrigin}/oauth/register`,
    jwks_uri: `${supabaseBase}/.well-known/jwks.json`,
    userinfo_endpoint: `${localOrigin}/oauth/userinfo`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "email", "profile", "phone"],
  }
}

/**
 * Handle GET /.well-known/oauth-authorization-server
 */
export function handleOAuthDiscovery(req: IncomingMessage, res: ServerResponse, port: number): void {
  const host = req.headers.host ?? `127.0.0.1:${port}`
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https"
  const localOrigin = `${protocol}://${host}`
  const metadata = buildOAuthMetadata(localOrigin)
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=3600",
  })
  res.end(JSON.stringify(metadata))
}

// ---------------------------------------------------------------------------
// OAuth proxy — forwards requests to Supabase with the apikey header
// ---------------------------------------------------------------------------

async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (chunk: Buffer) => { data += chunk.toString() })
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}

/**
 * Proxy an OAuth request to Supabase, injecting the required `apikey` header.
 * Supports both GET (authorize redirects) and POST (register, token).
 */
export async function handleOAuthProxy(
  req: IncomingMessage,
  res: ServerResponse,
  supabasePath: string
): Promise<void> {
  const supabaseTarget = `${getSupabaseUrl()}/auth/v1/oauth${supabasePath}`

  // For GET requests, forward query string
  const incomingUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  const targetUrl = new URL(supabaseTarget)
  incomingUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value)
  })

  const headers: Record<string, string> = {
    apikey: getSupabaseAnonKey(),
  }

  // Forward relevant headers
  if (req.headers["content-type"]) {
    headers["Content-Type"] = req.headers["content-type"]
  }
  if (req.headers["authorization"]) {
    headers["Authorization"] = req.headers["authorization"]
  }

  let body: string | undefined
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    body = await readRawBody(req)
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      method: req.method ?? "GET",
      headers,
      body,
      redirect: "manual", // Don't follow redirects — return them to the MCP client
    })

    // Copy status and headers from Supabase response
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      // Skip hop-by-hop and compression headers (fetch() already decompresses)
      if (!["transfer-encoding", "connection", "content-encoding"].includes(key.toLowerCase())) {
        responseHeaders[key] = value
      }
    })

    // Rewrite redirect Location to local webapp when GUARDIAN_WEBAPP_URL is set
    // (Supabase uses its configured Site URL which points to production)
    const webappUrl = getWebappUrl()
    if (webappUrl && responseHeaders["location"]) {
      const loc = responseHeaders["location"]
      // Replace the production origin with the local webapp origin
      const parsed = new URL(loc, "http://localhost")
      const localOrigin = webappUrl.replace(/\/+$/, "")
      responseHeaders["location"] = `${localOrigin}${parsed.pathname}${parsed.search}`
    }

    const responseBody = await response.text()
    res.writeHead(response.status, responseHeaders)
    res.end(responseBody)
  } catch (err) {
    console.error("[Guardian MCP] OAuth proxy error:", err instanceof Error ? err.message : String(err))
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "OAuth proxy error" }))
    }
  }
}

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

export interface AuthenticatedUser {
  id: string          // Supabase user UUID (from "sub" claim)
  email?: string
  role?: string
}

/**
 * Extract and verify the Bearer token from an incoming request.
 * Returns the authenticated user on success, or null if missing/invalid.
 */
export async function verifyRequest(req: IncomingMessage): Promise<AuthenticatedUser | null> {
  const authHeader = req.headers["authorization"]
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null
  }

  const token = authHeader.slice(7)
  if (!token) return null

  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: `${getSupabaseUrl()}/auth/v1`,
    })

    const sub = payload.sub
    if (!sub) return null

    return {
      id: sub,
      email: (payload as JWTPayload & { email?: string }).email,
      role: (payload as JWTPayload & { role?: string }).role,
    }
  } catch (err) {
    console.error(
      "[Guardian MCP] JWT verification failed:",
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

/**
 * Send a 401 response with proper WWW-Authenticate header for MCP OAuth.
 */
export function send401(req: IncomingMessage, res: ServerResponse, port: number): void {
  const host = req.headers.host ?? `127.0.0.1:${port}`
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https"
  const localOrigin = `${protocol}://${host}`
  const metadata = buildOAuthMetadata(localOrigin)
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer resource_metadata="${metadata.issuer}"`,
  })
  res.end(JSON.stringify({ error: "Unauthorized", message: "Valid Bearer token required." }))
}
