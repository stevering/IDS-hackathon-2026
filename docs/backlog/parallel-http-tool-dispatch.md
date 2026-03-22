# Parallel HTTP tool dispatch in agent workflows

## Context

When an agent LLM returns multiple tool calls in one response, they are currently executed **sequentially** in `executeLLMLoop`. This is correct for stdio MCP tools (single stdin/stdout pipe), but HTTP MCP tools (GitHub, Figma MCP cloud, FC remote) are stateless and could run in parallel.

## Goal

Process tool call effects by transport type:
- **stdio effects** (`figmaconsole_*` via local pool) → execute sequentially (same stdin pipe)
- **HTTP effects** (`github_*`, `figma_*`, `figmaconsole_*` via remote) → execute in parallel (`Promise.all`)

## Approach

In `executeLLMLoop` (`packages/temporal/src/workflows/agent.ts`), when processing `execute_external_tool` effects:

1. Separate effects into stdio vs HTTP groups based on resolved `serverId`
2. Execute HTTP group in parallel
3. Execute stdio group sequentially
4. Merge results

## Files

- `packages/temporal/src/workflows/agent.ts` — effect dispatch logic
- `packages/temporal/src/activities/mcp.ts` — `getServerDef()` to determine transport type

## Priority

Low — current sequential execution works. Parallelism is a performance optimization for multi-tool responses.
