# Context Engineering — Current State

How Guardian dynamically builds the LLM context (system prompt + message history) for chat and orchestration agents.

## Principle

Context engineering = injecting the right knowledge at the right time into the LLM context window. Guardian does this at two levels:

1. **Chat route** (`/api/chat`) — builds the system prompt per-request for interactive chat
2. **Agent workflows** (Temporal) — builds system prompt + injects knowledge into message history during orchestration

Both use the same pattern: conditional injection based on runtime flags.

## Chat route context (`packages/web/src/app/api/chat/route.ts`)

The system prompt is rebuilt on every POST request:

```
GUARDIAN_SYSTEM_PROMPT (base, always present)
  + Selected Figma Node (if plugin has a selection)
  + Figma Plugin Context (if file is open: fileName, fileKey, pages, currentUser)
  + Connected Agents (if agents are connected: shortIds, file names, orchestration rules)
  + Current Model identity (model ID, source — so LLM can answer "what model are you?")
  + Thinking instructions (if model lacks native reasoning: <thinking> tag instructions)
```

Each section is conditional — only injected when the flag is true. This keeps the prompt minimal.

### Trigger flags

| Flag | Source | What it injects |
|---|---|---|
| `selectedNode` present | Request body (plugin sends selection) | Node URL + JSON properties |
| `figmaPluginContext.fileName` | Request body (plugin sends file context) | File name, key, URL, pages, user |
| `connectedAgents.length > 0` | Request body (presence channel) | Agent list + orchestration rules |
| `!supportsReasoning` | Request body (from gateway catalog tags) | `<thinking>` tag instructions |
| `resolvedModel.modelId` | Model resolver result | `## Current Model` section |
| `isLocalPlugin` | Request body | Adjusts tool instructions (figma_plugin_execute vs guardian_figma_execute) |

### Per-message metadata

Each assistant message is saved with metadata JSONB: `{ model, source, keyId, keyLabel, keyHint }`.
This traces which model/provider/key produced each message — useful for debug and analytics.

## Agent workflow context (`packages/orchestrations/src/logic/system-prompts.ts`)

### Orchestrator prompt

Built by `buildOrchestratorSystemPrompt()`:
- Task description
- Available agents list (shortIds, labels, file names)
- Tool definitions (send_agent_directive, mark_agent_done, broadcast_to_agents)
- Directive sizing rules (sequential, one deliverable per directive)
- Agent-specific guidance (Figma agents: include dimensions, colors, spacing)
- State machine rules (don't re-send directives, mark done when complete)

### Agent prompt

Built by `buildAgentSystemPrompt()`:
- Agent identity (shortId, label, type)
- Peer agents list
- Task context
- Communication tools (signal_task_complete, send_peer_message, broadcast)
- Figma execution strategy — **conditional on `hasExternalFigmaTools`**:

| `hasExternalFigmaTools` | What's injected |
|---|---|
| `true` (figmaconsole_* tools available) | Slim prompt: "use figmaconsole_ tools, tool priority list, execution workflow" |
| `false` (only figma_plugin_execute) | Full prompt: complete `FIGMA_API_QUICK_REFERENCE` (~200 lines) with API tables, code examples, gotchas |

### Lazy injection

| What | When injected | File |
|---|---|---|
| `FIGMA_API_EXECUTE_SUPPLEMENT` | First time agent calls raw `figma_execute` (not create_child etc.) | `agent.ts` |
| Figma docs from web | When agent calls `lookup_figma_docs({ topic: "TextNode" })` | `fetch-figma-docs.ts` |

### Knowledge sources

| Source | Type | Content |
|---|---|---|
| `figma-api-reference.ts` — `FIGMA_API_QUICK_REFERENCE` | Static, compiled | Node creation, FrameNode, TextNode, fills, auto-layout, effects (~200 lines) |
| `figma-api-reference.ts` — `FIGMA_API_EXECUTE_SUPPLEMENT` | Static, lazy-injected | Gotchas + worked example for raw code execution |
| `fetch-figma-docs.ts` — `fetchFigmaDocsFromWeb()` | Dynamic, on-demand | Live fetch from `developers.figma.com/docs/plugins/api/{topic}/` (HTML stripped, 8000 chars max) |
| Southleft MCP tool descriptions | Dynamic, at discovery | Tool descriptions from `figmaconsole_*` tools (provided by Southleft server) |

## What's missing (content gap)

The Figma plugin for Claude Code (`figma/mcp-server-guide`) provides a `figma-use` skill with **12 reference files**:
- `gotchas.md` — font loading, fills format, auto-layout pitfalls
- `common-patterns.md` — creation patterns per node type
- `text-style-patterns.md` — text node specifics
- `variable-patterns.md` — Figma variables API
- `component-patterns.md` — component creation
- `effect-style-patterns.md` — shadows, blur
- `plugin-api-patterns.md` — plugin API patterns
- `plugin-api-standalone.d.ts` — complete TypeScript definitions
- `validation-and-recovery.md` — error handling
- `working-with-design-systems/*.md` — 8 sub-files on design system operations

Guardian's `FIGMA_API_QUICK_REFERENCE` covers ~20% of this content. The text visibility bug in the collab test (agent didn't call `loadFontAsync`) is a direct consequence of this gap.

## Key files

| File | Role |
|---|---|
| `packages/web/src/lib/system-prompt.ts` | `GUARDIAN_SYSTEM_PROMPT` base prompt |
| `packages/web/src/app/api/chat/route.ts` (lines 1088-1194) | Dynamic chat system prompt builder |
| `packages/orchestrations/src/logic/system-prompts.ts` | `buildOrchestratorSystemPrompt()`, `buildAgentSystemPrompt()` |
| `packages/orchestrations/src/logic/figma-api-reference.ts` | `FIGMA_API_QUICK_REFERENCE`, `FIGMA_API_EXECUTE_SUPPLEMENT` |
| `packages/orchestrations/src/logic/fetch-figma-docs.ts` | `fetchFigmaDocsFromWeb()` — live docs fetcher |
| `packages/web/src/app/hooks/useMessagePersistence.ts` | Per-message metadata (model/source/key tracing) |
