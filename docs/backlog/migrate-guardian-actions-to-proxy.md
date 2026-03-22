# Migrate Guardian MCP actions to Proxy system

## Context

Guardian's built-in MCP actions (`get_selection_context`, `get_node_variables`, `detect_token_overrides`, etc.) currently generate JavaScript code strings that are sent via `EXECUTE_CODE` (eval). The Proxy system (PROXY_CALL, PROXY_SNAPSHOT, PROXY_ITERATE, etc.) provides a structured alternative that avoids eval for simple operations.

## Current state

| Action | Current approach | Proxy alternative |
|---|---|---|
| `get_selection_context` | EXECUTE_CODE (JS template) | PROXY_ITERATE on selection |
| `get_node_variables` | EXECUTE_CODE (JS template) | PROXY_SNAPSHOT on node |
| `get_component_master` | EXECUTE_CODE (JS template) | PROXY_GET + PROXY_SNAPSHOT |
| `get_ds_variables` | EXECUTE_CODE (JS template) | PROXY_ITERATE (same as REFRESH_VARIABLES) |
| `detect_token_overrides` | EXECUTE_CODE (JS template) | Partially — conditional logic needed |
| `annotate_drift` | EXECUTE_CODE (JS template) | Not feasible — complex node creation |
| `list_page_children` (tool) | EXECUTE_CODE (inline JS) | PROXY_GET + PROXY_ITERATE |

## Challenge

The Proxy is currently only accessible from ui.html (via FigmaProxy client). Guardian MCP actions go through Supabase Realtime → webapp → plugin, which only knows EXECUTE_CODE. To use the Proxy from the MCP pipeline, either:

1. Expose Proxy commands through the Supabase Realtime channel (new message types)
2. Or have the webapp call FigmaProxy directly when it receives a "proxy request" instead of "execute_request"

## Files

- `packages/mcp/src/actions/builtin/index.ts` — action templates
- `packages/mcp/src/tools/list-page-children.ts` — inline JS
- `packages/web/src/app/hooks/useFigmaExecuteChannel.ts` — would need proxy support
- `packages/figma-plugin/ui.html` — FigmaProxy client already exists

## Priority

Low — EXECUTE_CODE works fine for these actions. Proxy would be cleaner but is not blocking.