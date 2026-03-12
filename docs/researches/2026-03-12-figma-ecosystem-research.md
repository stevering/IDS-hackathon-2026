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
- `generate_figma_design` — Code to Canvas: captures browser DOM → Figma layers (**remote-only, whitelisted clients only**)
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

### `generate_figma_design` — Client Whitelist (CRITICAL LIMITATION)

**Discovered 2026-03-12 via testing.**

The `generate_figma_design` tool is documented as **"specific clients only, remote only"**. Figma's remote MCP server (`mcp.figma.com/mcp`) identifies the connecting MCP client and only exposes the tool to whitelisted clients.

**Whitelisted clients (as of March 2026):**

| Client | Access | Source |
|--------|--------|--------|
| Claude Code (Anthropic) | Yes | Launch announcement, Feb 17 2026 |
| VS Code (GitHub Copilot) | Yes | GitHub Changelog, Mar 6 2026 |
| Codex (OpenAI) | Likely | Mentioned in Figma docs |
| Cursor, Windsurf, other editors | **No** | Not mentioned |
| Custom MCP clients (e.g. Guardian webapp) | **No** | Not a recognized client |

**Tested:** Calling `generate_figma_design` from Claude Code works (whitelisted). Calling it from an unrecognized MCP client would fail — the tool simply won't appear in the tool list.

**Implications for Guardian:**
- The Guardian webapp cannot use `generate_figma_design` via `mcp.figma.com/mcp` — it would not be recognized as a whitelisted client
- The desktop MCP server (`127.0.0.1:3845`) does NOT expose `generate_figma_design` at all (read-only: 6 tools)
- Code to Canvas remains exclusive to whitelisted terminal-based AI agents
- Guardian must continue using its own Plugin API execution approach (`guardian_figma_execute`) for design creation

**Workaround (tested, works):**
- From Claude Code (whitelisted), `generate_figma_design` can capture any site:
  - **Local sites:** inject `capture.js` in HTML layout + open browser with `#figmacapture=captureId`
  - **External sites:** use Playwright MCP to navigate, strip CSP headers, inject script, and call `captureForDesign()`
- This is useful as a complementary workflow alongside Guardian, but cannot be integrated into the Guardian webapp itself

**Sources:**
- [Tools and Prompts — "specific clients only"](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
- [Forum: generate_figma_design not available](https://forum.figma.com/report-a-problem-6/generate-figma-design-not-available-in-claude-code-connector-51173)
- [VS Code support added March 2026](https://github.blog/changelog/2026-03-06-figma-mcp-server-can-now-generate-design-layers-from-vs-code/)

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

---

## 6. Figma Clipboard Format — The Internal Conversion Mechanism

**Discovered 2026-03-12 via research.**

### How Figma consumes HTML as design layers

When you Cmd+V in Figma, it inspects the clipboard `text/html` data. If it contains a **proprietary Figma clipboard format** (specific metadata structure), Figma converts it into editable layers instead of plain text.

This is the same mechanism used by:
- **Figma's capture.js** (Code to Canvas)
- **code.to.design API** (divRIOTS)
- **html.to.design plugin** (divRIOTS)
- **figma-capture Chrome extension**

### The conversion pipeline

```
HTML + CSS (any source)
      │
      ▼
Conversion to "Figma clipboard format"     ← proprietary, undocumented
(text/html with special Figma metadata)
      │
      ▼
Clipboard: e.clipboardData.setData('text/html', figmaClipboardData)
      │
      ▼
Cmd+V in Figma → editable layers (frames, text, auto-layout, colors)
```

### Who produces this format

| Producer | How | Access | Cost |
|----------|-----|--------|------|
| **Figma capture.js** | Public script at `mcp.figma.com/.../capture.js`. Serializes DOM → POST to Figma endpoint OR clipboard | Whitelisted MCP clients only (for endpoint mode). Clipboard mode is unrestricted. | Free |
| **code.to.design API** (divRIOTS) | `POST https://api.to.design/html` with `clip: true` → returns clipboard data | Open — API key required | Paid API |
| **html.to.design plugin** (divRIOTS) | Browser extension + Figma plugin, uses same API internally | Open — Figma Community plugin | Free (limited) / Paid |
| **figma-capture extension** | Chrome extension that loads Figma's capture.js, intercepts clipboard, applies font fixes | Open source (GitHub) | Free |

### code.to.design API — clipboard mode (no whitelist)

```javascript
// 1. Convert HTML → Figma clipboard format
const response = await fetch('https://api.to.design/html', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_API_KEY'
  },
  body: JSON.stringify({
    html: '<style>${CSS}</style>${HTML}',
    clip: true   // ← returns Figma clipboard format
  })
});
const clipboardData = await response.text();

// 2. Inject into clipboard
document.addEventListener('copy', (e) => {
  e.clipboardData.setData('text/html', clipboardData);
  e.preventDefault();
});
document.execCommand('copy');

// 3. Cmd+V in Figma → editable layers
```

**Constraint:** API calls must occur within ~5 seconds of user interaction (browser clipboard security). Google Fonts only (no system fonts).

### code.to.design API — plugin mode (programmatic, no paste needed)

With `clip: false`, the API returns a structured format consumable by a **Figma plugin SDK**:
- Plugin calls the API with HTML
- API returns Figma node structure
- Plugin SDK creates the nodes via Plugin API
- No clipboard, no paste — fully programmatic

This is the same architecture as the deprecated `html-figma` library, but maintained and production-grade.

### Figma capture.js — clipboard mode (free, no whitelist)

The `capture.js` script is public and can be loaded by anyone. In clipboard mode (without `captureId`), it:
1. Serializes the DOM (traverses nodes, reads computed styles, extracts layout)
2. Writes the Figma clipboard format to the clipboard
3. Does NOT POST to the protected endpoint

```
Playwright → navigate to site → inject capture.js → trigger clipboard capture
→ clipboard contains Figma layers → paste in Figma
```

**Warning:** The clipboard format is undocumented and may change without notice.

---

## 7. `generate_figma_design` Bypass Strategies for Guardian

### Summary of approaches

| Approach | Whitelist bypass | Plugin needed | Fully programmatic | Cost | Stability |
|----------|-----------------|---------------|-------------------|------|-----------|
| Figma MCP `generate_figma_design` | **No** (whitelisted clients only) | No | Yes | Free | Stable |
| **capture.js clipboard mode** | **Yes** | No | Semi (requires paste) | Free | Fragile (undocumented format) |
| **code.to.design API clipboard** | **Yes** | No | Semi (requires paste) | Paid | Stable (maintained API) |
| **code.to.design API plugin mode** | **Yes** | Yes (SDK in plugin) | **Yes** | Paid | Stable |
| **Playwright + AI → Plugin API** | **Yes** | Yes (Guardian) | **Yes** | Free | Variable (AI accuracy 80-90%) |
| **Custom DOM serializer + Plugin** | **Yes** | Yes (Guardian) | **Yes** | Free | Depends on implementation |

### Recommended strategies for Guardian

**For quick wins (no code change):**
- Use `generate_figma_design` from Claude Code (whitelisted) alongside Guardian for modification
- Hybrid workflow: Claude Code pushes initial design, Guardian agents modify/complete it

**For full integration (code change required):**
1. **Best: code.to.design plugin mode** — if budget allows, integrate their SDK into Guardian plugin. API converts HTML → node structure, SDK creates nodes via Plugin API. Maintained, production-grade.
2. **Free: Playwright DOM extraction + Guardian Plugin API** — Playwright captures site, extracts computed styles + layout as JSON, sends to Guardian plugin via Supabase, plugin creates nodes. We already have the infrastructure, just need the DOM→Plugin API converter.
3. **Risky: capture.js clipboard interception** — use Figma's public script, intercept clipboard payload, parse and replay via Plugin API. Free but depends on undocumented format.

Sources:
- [code.to.design API docs](https://docs-code.to.design/overview)
- [code.to.design clipboard mode](https://docs-code.to.design/clipboard-mode)
- [figma-capture Chrome extension](https://github.com/vorbei/figma-capture)
- [html.to.design plugin](https://www.figma.com/community/plugin/1159123024924461424/html-to-design-by-divriots-import-websites-to-figma-designs-web-html-css)
- [code.to.design API announcement](https://divriots.com/blog/presenting-code-to-design-api/)

---

## 8. Clipboard Mode — Test & Validation (2026-03-12)

### Test: capture.js clipboard mode without Figma MCP

**Setup:**
- Guardian webapp running on `localhost:3000` (Next.js dev)
- `capture.js` injected via `layout.tsx` (`<script src="/vendor/figma-capture.js" async />`, dev only)
- Local copy downloaded from `mcp.figma.com/mcp/html-to-design/capture.js`
- **No Figma MCP connected** — all MCP servers disabled during test

**Test procedure:**
1. Open `http://localhost:3000#figmacapture&figmadelay=2000`
2. capture.js detects `#figmacapture` hash → waits 2s → serializes DOM → copies to clipboard
3. Toast confirmation appears in browser
4. Open Figma → Cmd+V → paste

**Result: SUCCESS** — Guardian webapp fully rendered as editable Figma layers (frames, text, auto-layout, colors).

**Key finding:** Clipboard mode is **100% client-side**. No MCP, no server, no whitelist, no auth needed. The script runs entirely in the browser and writes directly to the system clipboard.

### Hash parameters

| Parameter | Example | Description |
|-----------|---------|-------------|
| `#figmacapture` | (required) | Triggers auto-capture on page load |
| `&figmadelay=<ms>` | `&figmadelay=2000` | Wait before capture (let page render) |
| `&figmaselector=<css>` | `&figmaselector=.main-content` | Capture specific element only |
| `&figmaselector=*` | | Shows interactive selection UI |

### Programmatic capture (without hash)

```javascript
// Available after capture.js loads
const result = await window.figma.captureForDesign({ selector: 'body' });
// Result is written to clipboard automatically
```

---

## 9. capture.js — Technical Deep Dive

### How DOM → Figma clipboard works

**Step 1 — DOM serialization (capture.js, ~128KB minified)**

The script traverses the entire DOM tree and for each element:
- Reads computed CSS styles (colors, layout, fonts, spacing, borders, shadows, etc.)
- Converts CSS flex/grid → Figma auto-layout properties
- Converts CSS colors → RGB 0-1 range
- Converts CSS shadows → Figma DROP_SHADOW effects
- Extracts text content with font metadata
- References images by URL (Figma downloads them on paste)
- Extracts React Fiber props (`__reactFiber`) for component metadata when available
- Builds a JSON tree of serialized nodes

**Step 2 — Clipboard write**

The serialized JSON is written to the clipboard via `navigator.clipboard.write()` as `text/html` with proprietary markers:

```html
<meta charset="utf-8">
<span data-metadata="<!--(figmeta)...JSON metadata...-->">
<!--(figh2d)BASE64_ENCODED_JSON_PAYLOAD(/figh2d)-->
```

- `(figmeta)` — file/context metadata
- `(figh2d)` — "Figma HTML to Design" — the serialized node tree (base64-encoded JSON)

**Step 3 — Figma paste**

When Cmd+V is pressed in Figma:
1. Figma reads `text/html` from clipboard
2. Detects `(figmeta)` / `(figh2d)` markers
3. Decodes base64 → JSON → deserializes into native Figma nodes
4. Downloads referenced images
5. Creates editable frames, text, auto-layout, etc.

### Two operating modes

| Mode | Trigger | Server needed | Whitelist |
|------|---------|---------------|-----------|
| **Endpoint** | `captureForDesign({ captureId, endpoint })` | Yes — POSTs to `mcp.figma.com/capture/{id}/submit` | **Yes** (captureId from MCP) |
| **Clipboard** | `#figmacapture` hash OR `captureForDesign({ selector })` | **No** — writes to local clipboard | **No** |

### Internal API surface (from source analysis)

```javascript
window.figma.captureForDesign({
  captureId?: string,    // For endpoint mode (from generate_figma_design)
  endpoint?: string,     // POST target (default: mcp.figma.com)
  selector?: string,     // CSS selector to capture (default: 'body')
});

window.figma.__clipboardFlow(selector);  // Returns { showClipboardBar }
// Shows a toolbar for manual capture/selection
```

---

## 10. "HTML to Design" — Three Distinct Actors

The name "HTML to Design" is used by **three unrelated actors**, which causes confusion:

### Relationship map

```
divRIOTS (2022)                          Figma (2025-2026)
┌─────────────────────┐                  ┌──────────────────────────┐
│ html.to.design      │                  │ "HTML to Design"         │
│ (plugin + extension │  INSPIRED        │ (internal feature name)  │
│  + API)             │ ──────────────►  │                          │
│                     │  same concept    │ capture.js               │
│ Own capture engine  │                  │ Code to Canvas           │
│ Paid API            │                  │ generate_figma_design    │
└─────────────────────┘                  └──────────────────────────┘
                                                    │
                                                    │ USES (bundles)
                                                    ▼
                                         ┌──────────────────────────┐
                                         │ vorbei/figma-capture     │
                                         │ (Chrome extension)       │
                                         │                          │
                                         │ Bundles capture.js       │
                                         │ + post-processing:       │
                                         │   - CJK font fixes       │
                                         │   - Font mapping          │
                                         │   - DOM flattening        │
                                         │   - Empty node cleanup    │
                                         │                          │
                                         │ MIT, open source, free   │
                                         └──────────────────────────┘
```

| | capture.js (Figma) | vorbei/figma-capture | html.to.design (divRIOTS) |
|---|---|---|---|
| **Author** | Figma Inc. | Independent dev | divRIOTS (startup) |
| **Type** | Script (JS) | Chrome extension | Plugin + extension + API |
| **Capture engine** | **This IS the engine** | Uses Figma's capture.js | **Own engine** (independent) |
| **Clipboard format** | `figh2d` (Figma's format) | Same (intercepts & transforms) | Own format (API returns clipboard data) |
| **Price** | Free (public URL) | Free (MIT, open source) | Freemium → paid |
| **License** | None (proprietary) | MIT | Commercial |
| **Relationship** | Original | Wrapper + post-processing | Competitor / pioneer |

**Key insight:** divRIOTS **invented** the concept "HTML to Design" (2022). Figma later built their own official version under the same name (capture.js / Code to Canvas, 2025-2026). The two have **no code dependency** — completely separate implementations.

---

## 11. Legal Analysis — capture.js & Figma ToS

### Figma ToS restrictions (confirmed)

From [Figma SSA](https://www.figma.com/ssa/) and [Figma ToS](https://www.figma.com/legal/tos/):

> *"[You shall not] reverse engineer, decompile, disassemble, or otherwise attempt to discover the source code, object code, or underlying structure, ideas, know-how, or algorithms relevant to the Services"*

### Risk assessment for using capture.js

| Action | ToS risk | Rationale |
|--------|----------|-----------|
| Load capture.js from public URL at runtime | **Low** | Public endpoint, no auth, Figma serves it intentionally |
| Bundle/redistribute capture.js in your product | **High** | Proprietary code, no license, no redistribution rights |
| Depend on clipboard format `figh2d` | **High** | Undocumented internal format, no stability guarantee |
| Reverse-engineer the format to build own serializer | **High** | Explicitly prohibited by ToS ("reverse engineer...underlying structure") |
| Use capture.js in clipboard mode for personal/demo use | **Low** | No server interaction, no API abuse, personal use |
| Use capture.js in a published commercial product | **High** | Redistribution of proprietary code without license |

### What others do

| Actor | Approach | Legal stance |
|-------|----------|-------------|
| **vorbei/figma-capture** | Bundles capture.js, adds disclaimer: *"unofficial community tool for personal and educational use, not affiliated with Figma"* | Acknowledges risk, not commercial |
| **divRIOTS (html.to.design)** | **Own engine**, no use of capture.js | Clean — entirely their own code |
| **Figma MCP (official)** | It's their own script | N/A |

### Verdict for Guardian

| Use case | Recommended | Reasoning |
|----------|-------------|-----------|
| **Hackathon / internal demo** | ✅ Yes, use capture.js clipboard mode | No distribution, personal use, low risk |
| **Published product (marketplace or SaaS)** | ❌ No, don't redistribute capture.js | No license, ToS prohibits reverse engineering, format can break anytime |
| **Published product (alternative)** | ✅ Use code.to.design API (divRIOTS) | Licensed, maintained, stable API, their own engine |
| **Published product (free alternative)** | ✅ Build own DOM→Plugin API converter | Use Guardian's existing Plugin API execution, no dependency on Figma's proprietary format |

### Safe path for Guardian production

1. **Don't bundle capture.js** — remove from `public/vendor/` before publishing
2. **Don't reverse-engineer the `figh2d` clipboard format**
3. **Continue using Plugin API execution** (`figma_execute`) — official, documented API
4. **If DOM→Figma is needed:** either pay for code.to.design API, or build a DOM→Plugin API converter that reads computed styles and creates Figma nodes via the official Plugin API (not via the proprietary clipboard format)

Sources:
- [Figma SSA — reverse engineering clause](https://www.figma.com/ssa/)
- [Figma ToS](https://www.figma.com/legal/tos/)
- [Figma Developer Terms](https://www.figma.com/legal/developer-terms/)
- [vorbei/figma-capture disclaimer](https://github.com/vorbei/figma-capture)
- [Figma Plugin Review Guidelines](https://help.figma.com/hc/en-us/articles/360039958914-Plugin-and-widget-review-guidelines)
