# Propose HTTP mode for local FC MCP server (upstream PR to Southleft)

## Context

The local FC MCP server (`npx figma-console-mcp`, `src/local.ts`) only supports **stdio** transport. This means each MCP client (Claude Code, Temporal worker, Cursor) must launch its own subprocess — they cannot share a single server.

The cloud version (`src/index.ts`) uses `WebStandardStreamableHTTPServerTransport` for multi-client HTTP access, but this entrypoint is deployed on Cloudflare Workers, not available locally.

## Goal

Add a `--http [port]` flag to the local server (`local.ts`) that starts an HTTP MCP endpoint alongside the stdio transport. This would allow multiple clients to share one server instance:

```bash
npx figma-console-mcp --http 3333
```

```
Client 1 (Claude Code)  ─── HTTP localhost:3333/mcp ──→ ┐
Client 2 (Temporal)      ─── HTTP localhost:3333/mcp ──→ ├── Single FC MCP process
Client 3 (Cursor)        ─── HTTP localhost:3333/mcp ──→ ┘       └── WS port 9223
                                                                        └── Plugin
```

## Benefits

- Eliminates the need for the stdio pool (1 subprocess per agent)
- Eliminates port consumption (1 WS port instead of N)
- Eliminates instant connect mechanism (plugin connects once)
- Simplifies Temporal integration (HTTP is stateless, no pool needed)

## Repository

https://github.com/southleft/figma-console-mcp

## Priority

Low — the stdio pool with instant connect works. This is a cleaner long-term solution.
