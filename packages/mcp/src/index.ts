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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

const MODE = process.env.GUARDIAN_MCP_MODE ?? "stdio"
const PORT = parseInt(process.env.GUARDIAN_MCP_PORT ?? "3847", 10)

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
    // Health check endpoint (useful for dev + deployment)
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", server: "guardian-mcp", version: "0.1.0" }))
      return
    }

    // MCP endpoint
    if (req.url === "/mcp") {
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
      const server = createGuardianServer()
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
