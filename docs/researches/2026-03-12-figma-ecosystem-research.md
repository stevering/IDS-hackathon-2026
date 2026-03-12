# Figma Ecosystem Research — AI-Driven Design Modification

Date: 2026-03-12

## 1. Figma MCP Server (Official — Anthropic + Figma)

### Architecture

Claude Code communicates with Figma via an HTTP MCP server (`mcp.figma.com/mcp` remote, or `127.0.0.1:3845` local desktop).

- **No Figma plugin required** — everything goes through the REST API server-side
- **No Plugin API knowledge needed** — the AI never writes Figma Plugin API code
- **13 tools** — mostly read-only, with limited write capabilities

### Two deployment modes

| Mode | Endpoint | Figma Desktop required? | Access restriction |
|------|----------|------------------------|-------------------|
| Remote | `mcp.figma.com/mcp` | No — OAuth token only | **Whitelisted clients only** (VS Code, Cursor, Claude Code, Windsurf, Codex). Requires `mcp:connect` scope via DCR — third-party apps get 403 Forbidden. |
| Desktop | `127.0.0.1:3845/sse` | Yes — runs inside Figma Desktop | Open — available on Dev or Full seat for all paid plans |

### Tools

**Read tools (8):**
- `get_design_context` — code (React+Tailwind by default) + screenshot + hints. Requires `fileKey` + `nodeId`.
- `get_metadata` — sparse XML representation (layer IDs, names, types, positions)
- `get_screenshot` — visual capture of a node
- `get_variable_defs` — design tokens/variables
- `get_code_connect_map` — Figma node ↔ code component mappings
- `get_code_connect_suggestions` — auto-detected potential mappings
- `get_figjam` — FigJam board metadata as XML + screenshots
- `whoami` — authenticated user info (remote-only)

**Write tools (5):**
- `generate_figma_design` — Code to Canvas: captures browser DOM → Figma layers (remote-only)
- `generate_diagram` — Mermaid syntax → FigJam diagram
- `add_code_connect_map` — creates Figma ↔ code mappings (metadata only)
- `send_code_connect_mappings` — confirms suggested mappings
- `create_design_system_rules` — generates rule files (writes to local filesystem, not Figma)

**No tool allows modifying existing Figma layers.** Write operations are append-only or metadata-only.

### Code to Canvas (`generate_figma_design`) — Technical Flow

1. Claude calls `generate_figma_design()` → receives a `captureId` (single-use token)
2. Claude injects Figma's capture script (`mcp.figma.com/.../capture.js`) into the app layout
3. Claude opens the browser with `URL#captureId=xxx`
4. The capture script serializes the DOM (not a screenshot): texts, colors, layout (flex/grid → auto-layout), images, hierarchy
5. The script POSTs the serialized DOM + captureId to Figma Cloud
6. Figma Cloud converts DOM → native Figma nodes (server-side, proprietary pipeline): CSS flex → auto-layout, CSS colors → RGB 0-1, CSS shadows → DROP_SHADOW effects, DOM tree → frame hierarchy
7. Claude polls captureId every 5s until "completed"
8. Returns the Figma file URL with editable layers

**Output modes:** `newFile` (creates a new .fig file), `existingFile` (appends to file via `fileKey`, optionally at `nodeId`), `clipboard` (paste manually).

### Desktop mode limitations

- **Does NOT know which file is open** — `fileKey` + `nodeId` are always required (extracted from URLs)
- **Does NOT know the current selection** — user must "Copy link to selection" and paste the URL
- Desktop mode is a local proxy to the REST API, not a direct connection to Figma's state

### Key characteristics

- Zero friction: no plugin to install, no window to keep open (remote mode)
- No ability to modify existing designs programmatically
- AI is "blind" without explicit Figma URLs
- Use case: dev workflow (read design → code, capture site → design)
- **Remote mode is restricted** (as of March 2026): only whitelisted MCP clients can use `mcp.figma.com/mcp`. Third-party apps must use the Desktop mode or the Figma REST API.

---

## 2. Figma Console MCP (Southleft)

### Architecture

```
Claude Code / Cursor ── MCP (HTTP) ──► Southleft MCP Server
                                            │
                                     WebSocket (ports 9223-9232)
                                            │
                                            ▼
                              Figma Plugin UI (iframe, WS client)
                                            │
                                       postMessage
                                            │
                                            ▼
                              Figma Plugin Worker (code.js)
                                            │
                                      Figma Plugin API
```

- **Requires a Figma plugin** — manually imported via manifest (dev mode, NOT on marketplace)
- **57+ tools** in local mode (22 in remote read-only mode)
- **Executes arbitrary Plugin API code** via `figma_execute`
- Full file-aware context: knows current page, selection, variables
- Communication: WebSocket local (ports 9223-9232)

### Plugin API knowledge approach

- **Manual knowledge embedded in MCP server instructions** (system prompt)
- Same approach as Guardian: hand-written API reminders (colors 0-1, auto-layout, text/fonts, node lookup, etc.)
- Same gaps as Guardian at time of research: no DROP_SHADOW or fill opacity rules
- No auto-generation from `@figma/plugin-typings`

### Distribution

- Dev mode only (manifest import)
- Not on the Figma Community marketplace
- MIT licensed, open source on GitHub

---

## 3. Guardian (Our Approach)

### Architecture

```
Webapp (orchestrator/collaborator) ── Supabase Realtime ──► Figma Plugin (sandbox)
                                                                  │
                                                           Figma Plugin API
```

- **Requires a Figma plugin** — dev mode (manifest import)
- Communication: Supabase Realtime (WebSocket broadcast) — works locally and remotely
- Executes arbitrary Plugin API code via `guardian_figma_execute`
- Full file-aware context: current page, selection, variables
- Multi-agent orchestration: 1 orchestrator + N collaborators (unique to Guardian)

### Plugin API knowledge approach

- Manual knowledge in two delivery paths:
  1. `guardian-tools-knowledge.ts` → system prompt (webapp agent) + MCP ServerOptions.instructions (external clients)
  2. `figma-execute.ts` tool description → visible when AI discovers the tool
- Same approach as Figma Console MCP (manual, no auto-generation)

---

## 4. Comparison Matrix

| Feature | Figma MCP (Official) | Figma Console (Southleft) | Guardian |
|---------|---------------------|--------------------------|----------|
| Plugin required | No | Yes (dev mode) | Yes (dev mode) |
| Marketplace | N/A | No | No |
| Modify existing designs | No | Yes | Yes |
| Create designs from scratch | No (DOM capture only) | Yes | Yes |
| File-aware (knows open file) | No | Yes | Yes |
| Selection-aware | No | Yes | Yes |
| Multi-agent orchestration | No | No | Yes |
| AI writes Plugin API code | No | Yes | Yes |
| API knowledge needed | No | Yes (manual) | Yes (manual) |
| Transport | HTTP REST API | WebSocket local | Supabase Realtime |
| Deployment | Remote (cloud) or local | Local only | Local + remote |

---

## 4b. Tool Availability by Source and Mode

### Official Figma MCP — Tool availability per server

| Tool | Desktop (`localhost:3845`) | Remote (`mcp.figma.com/mcp`) |
|------|--------------------------|------------------------------|
| `get_design_context` | ✅ | ✅ |
| `get_metadata` | ✅ | ✅ |
| `get_screenshot` | ✅ | ✅ |
| `get_variable_defs` | ✅ | ✅ |
| `get_code_connect_map` | ✅ | ✅ |
| `get_code_connect_suggestions` | ✅ | ✅ |
| `send_code_connect_mappings` | ✅ | ✅ |
| `add_code_connect_map` | ✅ | ✅ |
| `get_figjam` | ✅ | ✅ |
| `generate_diagram` | ✅ | ✅ |
| `create_design_system_rules` | ✅ | ✅ |
| `generate_figma_design` | ❌ **Remote-only** | ✅ |
| `whoami` | ❌ **Remote-only** | ✅ |

### Figma Console MCP (Southleft) — Mode comparison

| Aspect | Local (NPX + plugin) | Remote (online, OAuth) |
|--------|---------------------|----------------------|
| Tools count | 57+ | 22 |
| Read (files, variables, styles) | ✅ | ✅ |
| Write canvas (create/modify nodes) | ✅ (Plugin API) | ❌ |
| Variable management (create/update/delete) | ✅ | ❌ |
| `figma_execute` (arbitrary code) | ✅ | ❌ |
| Plugin required | Yes | No |
| Auth | WebSocket local | OAuth Figma |

### Cross-source capability matrix — What Guardian can access

| Capability | Figma Console online (`figmaconsole_*`) | Figma Desktop MCP (`figma_*`) | Guardian Plugin (`guardian_*`) | Figma REST API |
|-----------|----------------------------------------|-------------------------------|-------------------------------|----------------|
| Read file metadata | ✅ | ✅ | ✅ (via execute) | ✅ |
| Read node properties | ✅ | ✅ | ✅ (via execute) | ✅ |
| Export screenshots | ❌ | ✅ | ✅ (via `exportAsync`) | ✅ |
| Read variables/tokens | ✅ | ✅ | ✅ (via execute) | ✅ (beta) |
| Code generation (React+Tailwind) | ❌ | ✅ (`get_design_context`) | ❌ | ❌ |
| Write canvas nodes | ❌ | ❌ (append-only) | ✅ | ❌ |
| Modify existing nodes | ❌ | ❌ | ✅ | ❌ |
| Write variables | ❌ | ❌ | ✅ (via execute) | ✅ |
| Code to Canvas (`generate_figma_design`) | ❌ | ❌ (remote-only) | ⚠️ Workaround (manual Plugin API) | ❌ |
| Selection-aware | ❌ | ❌ | ✅ | ❌ |
| File-aware (knows open file) | ❌ | ❌ | ✅ | ❌ |
| Works remotely (no local Figma) | ✅ | ❌ | ✅ (needs plugin open) | ✅ |
| Auth required | OAuth Figma | None (local) | Supabase | OAuth Figma |

### Access restrictions (as of March 2026)

| Source | Access restriction |
|--------|--------------------|
| Figma MCP Remote (`mcp.figma.com/mcp`) | **Whitelisted clients only** — DCR returns 403, `mcp:connect` scope not in developer portal. Request form on Asana (beta, no guarantee). |
| Figma MCP Desktop (`localhost:3845`) | Open — requires Figma Desktop + Dev or Full seat (paid plan). |
| Figma Console Remote | Open — OAuth with any Figma account. 22 read-only tools. |
| Figma Console Local | Open — requires plugin + NPX. 57+ tools with full read/write. |
| Guardian Plugin | Open — requires plugin + Supabase connection. Full read/write via Plugin API. |
| Figma REST API | Open — OAuth with standard scopes (`file_content:read`, etc.). Read + limited write (variables, comments). |

### Guardian agent tool priority chain

For operations where multiple sources can serve, the agent should follow this priority order:

**Reading** (files, nodes, metadata, variables, screenshots):
1. Figma Console MCP (`figmaconsole_*`) — if connected
2. Figma Desktop MCP (`figma_*`) — if available locally
3. Guardian Plugin (`guardian_run_action` / `guardian_figma_execute`) — fallback

**Arbitrary code execution** (`figma_execute`):
1. Guardian (`guardian_figma_execute`) — priority
2. Figma Console plugin (`figmaconsole_figma_execute`) — if Guardian unavailable

**Writing canvas** (create/modify nodes, components, styles):
1. Figma Desktop MCP (`figma_*`) — if available locally
2. Guardian Plugin (`guardian_figma_execute`) — otherwise

**Code to Canvas** (`generate_figma_design`):
1. Figma Desktop MCP → ❌ not available (remote-only tool)
2. Figma MCP Remote → ❌ blocked (whitelist)
3. Workaround: agent reads source code → generates Plugin API code → executes via `guardian_figma_execute`

---

## 4c. `figma.fileKey` — Private Plugin API

`figma.fileKey` returns the file key of the current file the plugin is running on. This is required to build file URLs and make REST API calls.

**Availability:**

| Mode | `figma.fileKey` available |
|------|--------------------------|
| Dev mode (manifest import) + `enablePrivatePluginApi: true` | ✅ |
| Published private (organization plugin) | ✅ |
| Published public (Community marketplace) | ❌ |

- Only **private plugins** and Figma-owned resources (Jira, Asana widgets) have access
- Requires `"enablePrivatePluginApi": true` in `manifest.json` — this flag also enables the API during local development
- Public plugins cannot access `figma.fileKey` by any means — the user must paste the file URL manually (this is what the official Figma Desktop MCP does)
- Figma Console MCP (Southleft) and Guardian both use `figma.fileKey` because they run as private/dev-mode plugins

**Implication for publishing:** If Guardian is ever published to the Community marketplace, `figma.fileKey` will stop working. Alternative: prompt the user to paste the file URL. For organization-private publishing, no impact.

Sources: [Plugin API — figma.fileKey](https://developers.figma.com/docs/plugins/api/figma/), [Manifest — enablePrivatePluginApi](https://developers.figma.com/docs/plugins/manifest/)

---

## 5. Figma Plugin Marketplace — Publishing Rules

Source: [Figma Plugin Review Guidelines](https://help.figma.com/hc/en-us/articles/360039958914-Plugin-and-widget-review-guidelines)

### Allowed

- External network calls (must declare in description)
- Third-party account requirements (must mention)
- Monetization via external service redirection
- UI iframe loading external services (HTTPS)
- Any official Plugin API usage

### Prohibited / Risky for AI-bridge plugins

| Rule | Risk level | Notes |
|------|-----------|-------|
| "Cannot read/modify file without user's explicit awareness and consent" | Medium | User must see/approve AI actions |
| "Cannot exploit APIs via deceptive file manipulation" | Medium | AI-generated code could do unexpected things |
| "Long-running background processes subject to rejection" | High | Agent orchestration runs for minutes |
| "Cannot negatively impact Figma performance" | Medium | Arbitrary code execution can crash/slow down |
| "Must protect privacy and security of customer data" | Medium | Design data transits via Supabase — need privacy policy |
| "Plugins can only leverage official plugin APIs" | Ambiguous | We use official APIs, but code is AI-generated, not pre-written |

### Verdict

Technically publishable, but:
1. **Transparency** — user must see/approve each execution
2. **Privacy policy** — mandatory for plugins processing user data
3. **Long-running justification** — orchestration is interactive, not silent background
4. Neither Figma Console MCP nor Guardian are currently on the marketplace — possibly deliberate
