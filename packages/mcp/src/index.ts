/**
 * Guardian MCP Server — entry point
 *
 * Transport selection via GUARDIAN_MCP_MODE environment variable:
 *   stdio  (default) → for Claude Desktop, VS Code, local AI clients
 *   http             → for the Next.js webapp via @ai-sdk/mcp (port GUARDIAN_MCP_PORT)
 *
 * Usage:
 *   stdio:  tsx src/index.ts
 *   http:   GUARDIAN_MCP_MODE=http GUARDIAN_MCP_PORT=3847 tsx src/index.ts
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import { createGuardianServer } from "./server.js"
import { handleOAuthDiscovery, handleOAuthProxy, verifyRequest, send401 } from "./auth.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

const MODE = process.env.GUARDIAN_MCP_MODE ?? "stdio"
const PORT = parseInt(process.env.GUARDIAN_MCP_PORT ?? "3847", 10)
// Skip JWT verification in dev to avoid needing RS256 keys locally
const SKIP_AUTH = process.env.GUARDIAN_MCP_SKIP_AUTH === "true"

// --------------------------------------------------------------------------
// HTTP transport (for Next.js webapp integration)
// Stateful sessions: each client connection maintains its own transport.
// --------------------------------------------------------------------------

async function startHttpServer(port: number): Promise<void> {
  // Session registry: sessionId → { server, transport }
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >()

  async function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = ""
      req.on("data", (chunk: Buffer) => { data += chunk.toString() })
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : undefined)
        } catch {
          reject(new Error("Invalid JSON body"))
        }
      })
      req.on("error", reject)
    })
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight (needed for webapp cross-origin requests)
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
        "Access-Control-Max-Age": "86400",
      })
      res.end()
      return
    }

    // Health check endpoint (useful for dev + deployment)
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", server: "guardian-mcp", version: "0.1.0" }))
      return
    }

    // OAuth 2.1 discovery — required by MCP spec for Claude Code / other MCP clients
    if (
      req.method === "GET" &&
      (req.url === "/.well-known/oauth-authorization-server" ||
       req.url === "/.well-known/oauth-authorization-server/mcp")
    ) {
      handleOAuthDiscovery(req, res, port)
      return
    }

    // OAuth proxy endpoints — forward to Supabase with apikey header injected
    const oauthUrl = req.url?.split("?")[0]
    if (oauthUrl === "/oauth/register" || oauthUrl === "/oauth/token" || oauthUrl === "/oauth/authorize" || oauthUrl === "/oauth/userinfo") {
      // Supabase DCR endpoint is at /oauth/clients/register, not /oauth/register
      const supabasePath = oauthUrl === "/oauth/register"
        ? "/clients/register"
        : oauthUrl.replace("/oauth", "")
      await handleOAuthProxy(req, res, supabasePath)
      return
    }

    // MCP endpoint
    if (req.url === "/mcp") {
      // ── Authentication gate ──────────────────────────────────────────
      if (!SKIP_AUTH) {
        const user = await verifyRequest(req)
        if (!user) {
          send401(req, res, port)
          return
        }
        // Attach user info for downstream tools (scoping channels by userId)
        ;(req as IncomingMessage & { guardianUser?: typeof user }).guardianUser = user
      }

      // Extract userId for Supabase Realtime channel scoping
      const guardianUser = (req as IncomingMessage & { guardianUser?: { id: string } }).guardianUser
      const userId = guardianUser?.id

      const sessionId = req.headers["mcp-session-id"] as string | undefined

      // Reuse existing session
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!
        try {
          const body = await readBody(req)
          await session.transport.handleRequest(req, res, body)
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: String(err) }))
          }
        }
        return
      }

      // New session — create fresh server + transport pair
      const server = createGuardianServer(userId)
      let newSessionId: string | undefined

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => {
          newSessionId = randomUUID()
          return newSessionId
        },
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport })
          console.error(`[Guardian MCP] Session opened: ${id}`)
        },
      })

      transport.onclose = () => {
        if (newSessionId) {
          sessions.delete(newSessionId)
          console.error(`[Guardian MCP] Session closed: ${newSessionId}`)
        }
      }

      await server.connect(transport)

      try {
        const body = await readBody(req)
        await transport.handleRequest(req, res, body)
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: String(err) }))
        }
      }
      return
    }

    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("Not found")
  })

  await new Promise<void>((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => resolve())
  })

  // Graceful shutdown: close the HTTP server so the port is released immediately
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      httpServer.close()
    })
  }

  console.error(`[Guardian MCP] HTTP server running on http://127.0.0.1:${port}/mcp`)
  console.error(`[Guardian MCP] Health: http://127.0.0.1:${port}/health`)
}

// --------------------------------------------------------------------------
// stdio transport (for Claude Desktop, VS Code, etc.)
// --------------------------------------------------------------------------

async function startStdioServer(): Promise<void> {
  const server = createGuardianServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[Guardian MCP] stdio server started")
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  // Ensure clean shutdown when parent (Turborepo) sends SIGTERM/SIGINT
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.error(`[Guardian MCP] Received ${signal}, shutting down.`)
      process.exit(0)
    })
  }

  if (MODE === "http") {
    await startHttpServer(PORT)
  } else {
    await startStdioServer()
  }
}

main().catch((err: unknown) => {
  console.error("[Guardian MCP] Fatal error:", err)
  process.exit(1)
})
