# @guardian/mcp-server

Design System AI Guardian — MCP server that provides structured investigation playbooks and Figma plugin bridge capabilities to help AI agents assess DS compliance, detect drift, and evaluate component reuse.

## Overview

The Guardian MCP server is the intelligence layer of the DS AI Guardian system. It answers 5 key design system questions:

| Question | Tool |
|---|---|
| Does this component already exist in the DS? | `guardian_check_component_usage` |
| Has this component drifted from its master? | `guardian_analyze_drift` |
| Is this custom component a true snowflake? | `guardian_assess_snowflake` |
| Is this pattern emerging across teams? | `guardian_surface_pattern` |
| Should we file a DS extension request? | `guardian_document_gap` |

Each tool returns a **structured investigation playbook** — a step-by-step plan telling the AI agent *what to look for*, *where to look*, and *how to interpret findings*.

## Quick start

```bash
# Development (HTTP mode for Next.js webapp)
pnpm dev

# Development (stdio mode for Claude Desktop / VS Code)
pnpm dev:stdio

# Build
pnpm build

# Run built server
pnpm start

# Debug with MCP Inspector
pnpm inspector
```

## Transport modes

The server supports two transport modes via the `GUARDIAN_MCP_MODE` env variable:

| Mode | Use case | Default port |
|---|---|---|
| `stdio` (default) | Claude Desktop, VS Code, local AI clients | — |
| `http` | Next.js webapp via `@ai-sdk/mcp` | 3847 |

HTTP mode is **session-based**: each client connection gets a unique `mcp-session-id` header, with its own server instance.

## Tools

### Investigation tools (playbook-based)

These return structured JSON playbooks. No Figma plugin connection required.

#### `guardian_check_component_usage`

Check if a component exists in the DS before building a custom one.

```
Params:
  componentName  (string, required) — e.g. "Button", "Card"
  domain         (string, optional) — "figma" | "code" | "general"
```

#### `guardian_analyze_drift`

Analyze whether a component has drifted from its DS master.

```
Params:
  componentName  (string, required)
  figmaNodeId    (string, optional) — specific Figma node to compare
  customTokens   (object, optional) — hardcoded values already detected, e.g. { "color": "#FF0000" }
  currentFile    (string, optional) — file path in codebase
```

If `customTokens` are provided, drift is treated as **confirmed** and the investigation focuses on measuring scope.

#### `guardian_assess_snowflake`

Evaluate whether a custom component is genuinely unique or should be standardized.

```
Params:
  componentName  (string, required)
  codeSnippet    (string, optional) — the custom implementation
  domain         (string, optional) — "figma" | "code" | "general"
```

#### `guardian_surface_pattern`

Assess whether a repeating pattern has reached maturity for DS inclusion.

```
Params:
  componentName      (string, required)
  estimatedInstances (number, optional) — known instance count (≥3 triggers escalation flag)
```

#### `guardian_document_gap`

Build the case for a formal DS extension request when a component is missing a variant or property.

```
Params:
  componentName  (string, required)
  missingVariant (string, optional) — e.g. "size=xs", "type=warning"
  domain         (string, optional) — "figma" | "code" | "general"
```

### Execution tools (Figma plugin bridge)

These require the Guardian Figma plugin to be open and connected.

#### `guardian_figma_execute`

Execute arbitrary Figma Plugin API code via the Guardian plugin bridge.

```
Params:
  code     (string, required) — Plugin API JavaScript to execute
  timeout  (number, optional) — execution timeout in ms (default: 10000)
```

#### `guardian_list_skills`

List all available Guardian skills (built-in + user-defined).

```
Params:
  category  (string, optional) — filter: "ds-inspection" | "ds-annotation" | "variables" | "nodes" | "components" | "user"
```

#### `guardian_run_skill`

Run a named skill with parameters. Skills are pre-validated Figma Plugin API code templates.

```
Params:
  name    (string, required) — skill name from guardian_list_skills
  params  (object, optional) — parameters for the skill
```

## Built-in skills

| Skill | Category | Params | Description |
|---|---|---|---|
| `get_selection_context` | ds-inspection | — | Snapshot of selected node(s): type, size, fills, strokes, variables |
| `get_node_variables` | ds-inspection | `nodeId` | List all design variables bound to a node |
| `detect_token_overrides` | ds-inspection | `nodeId` | Flag hardcoded (non-token) values on fills/strokes |
| `get_component_master` | ds-inspection | `nodeId` | Find master component and list overridden properties |
| `get_ds_variables` | ds-inspection | `filterName?` | List all local tokens in file, grouped by collection |
| `annotate_drift` | ds-annotation | `nodeId`, `message?` | Add yellow warning sticky near a drifted node |

### Custom skills

Add user-defined skills as JSON files in `skills/user/<skill-name>.json`:

```json
{
  "name": "my_skill",
  "description": "What it does",
  "category": "user",
  "params": [
    { "name": "nodeId", "type": "string", "required": true, "description": "Target node" }
  ],
  "codeTemplate": "const node = figma.getNodeById('{{nodeId}}'); return { name: node.name };",
  "version": "1.0.0"
}
```

## Architecture

```
┌─────────────────┐    stdio/http    ┌──────────────────────┐
│  Claude Desktop │◄────────────────►│                      │
│  VS Code        │                  │  Guardian MCP Server │
│  Claude Code    │                  │                      │
└─────────────────┘                  │  ┌────────────────┐  │
                                     │  │ Investigation   │  │
┌─────────────────┐    http :3847    │  │ Playbooks       │  │
│  Next.js webapp │◄────────────────►│  ├────────────────┤  │
│  (@guardian/web) │                 │  │ Skills Registry │  │
└─────────────────┘                  │  ├────────────────┤  │
                                     │  │ Figma Bridge    │  │
                                     │  │ (Phase 2)       │  │
                                     │  └────────────────┘  │
                                     └──────────┬───────────┘
                                                │
                                     ┌──────────▼───────────┐
                                     │  Guardian Figma      │
                                     │  Plugin (Phase 2)    │
                                     └──────────────────────┘
```

**Playbook-driven**: The server provides investigation *strategy* (what to look for, where, how to interpret). The AI agent uses its own tools (Figma MCP, GitHub, code search) to execute the steps.

**Skills**: Pre-validated Figma Plugin API code templates that run inside the Figma plugin sandbox. Built-in skills cover common DS compliance checks; custom skills can be added as JSON.

## Dependencies

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP protocol implementation |
| `zod` | Input validation for tool parameters |

## Configuration

| Env variable | Default | Description |
|---|---|---|
| `GUARDIAN_MCP_MODE` | `stdio` | Transport mode: `stdio` or `http` |
| `GUARDIAN_MCP_PORT` | `3847` | HTTP server port (http mode only) |
