# Sticky task queues for multi-worker Temporal deployment

## Context

The stdio MCP pool (`stdioPool` Map in `mcp.ts`) is module-level state in the Temporal worker process. In dev with 1 worker, all activities for a given workflow land on the same process and reuse the pool.

In production with **multiple workers**, activities may land on different workers. An agent's `discoverMCPTools` could create a pool entry on Worker A, but `executeMCPTool` could land on Worker B where the pool is empty → new subprocess, new WS port, plugin not connected.

## Goal

Ensure all activities for a given agent workflow always run on the same worker process, so the stdio pool is consistent.

## Approach

Temporal supports **sticky execution** via worker-specific task queues:

1. At agent workflow start, create a unique task queue (e.g. `guardian-agent-#pomipo`)
2. Register the worker to poll this queue
3. All MCP activities for this agent are dispatched to this queue
4. Only 1 worker handles them → pool is consistent

Alternative: use session-based workers (Temporal's built-in sticky sessions feature).

## Files

- `packages/temporal/src/workflows/agent.ts` — activity dispatch
- `packages/temporal/src/worker.ts` — task queue registration

## Priority

Low — only needed when scaling to multiple Temporal workers in production. Single-worker dev mode works fine.
