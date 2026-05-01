# DS AI GUARDIAN (TEAM CTRL_ALT_DESIGN)

## About the Hackathon

This project was developed as part of the **IDS Hackathon 2026**, an event aimed at exploring the possibilities of artificial intelligence in the field of design systems and UI/UX consistency.

💻 Hackathon [IDS page](https://www.intodesignsystems.com/hackathon)

🗳️ Into Design Systems [Website](https://www.intodesignsystems.com/)

## The Project

**DS AI Guardian** is an intelligent AI assistant designed to ensure consistency between Figma designs and their code implementation. The tool automatically analyzes design files and source code to detect discrepancies, suggest corrections, and maintain design system integrity.

🧩 Our project [on GitHub](https://github.com/stevering/IDS-hackathon-2026)

🎥 Check out our [live demo](https://youtube.com/live/hOUN5crsNVI?si=nqKLkrbhMVOiYt9V&t=3433)

🪧 Our [Slides presentation](https://www.figma.com/deck/AUexRJNYDfH8f36UTVjKdx)

Our [FigJam Board](https://www.figma.com/board/86wDN58TgmzjgauRgptUp2/DS-AI-GUARDIAN?node-id=0-1&t=d4TWnW6sujrYmU3D-1)


Prototype A of the [DS AI Guardian integration inside Figma](https://www.figma.com/make/0a4PRBZ2Ha7OXWvKCKCWaJ/02_07_Guardian_combined?t=67PyKxvrnULdKQ0y-20&fullscreen=1)

Another [Prototype B integrated inside Figma](https://www.figma.com/make/YDX877Ofl0A4o7MBLf8Xdn/Design-Figma-UI-Layout?fullscreen=1&t=jXubMDqI7Afwcd1l-1)

Prototype C of the [DS AI Guardian integration inside Figma](https://www.figma.com/make/VhgxNwY7IxiC5c0TYpyN4L/Guardian?fullscreen=1&t=gfqa36K6UW3bndlf-1)

## The Team

Thank you to the entire team, it was extraordinary : 🎉

[Olusola Oduntan](https://www.linkedin.com/in/oduntan-olusola7)

[Jinyu Li](https://www.linkedin.com/in/jinyu-li-978652b9)

[Nina Berlič](https://www.linkedin.com/in/nina-berlic)

[Konstantinos Dimitropoulos](https://www.linkedin.com/in/kondimitropoulos)

[Elleta McDaniel](https://www.linkedin.com/in/elleta-mcdaniel)

[Jun Taoka](https://www.linkedin.com/in/juntaoka)

[Stéphane Chevreux](https://www.linkedin.com/in/stephane-chevreux)

[Amanda Silva](https://www.linkedin.com/in/amanda-silva-creates)

## Application

### Key Features

- 🎨 **Figma Analysis**: Direct connection to Figma files via MCP to extract components, styles, and tokens
- 💻 **Code Analysis**: Source code inspection to identify components and their implementation
- 🔍 **Discrepancy Detection**: Automatic comparison between design and code to spot inconsistencies
- 💬 **Conversational Interface**: AI chat to ask questions and get recommendations
- 🔧 **Correction Suggestions**: Concrete proposals to align code with the design system

### Architecture

The project uses an architecture based on the **Model Context Protocol (MCP)** to connect the AI to data sources (Figma and filesystem), enabling real-time analysis and contextual interactions.

The repository is structured as a **pnpm monorepo** managed with [Turborepo](https://turbo.build/):

```
/                              ← workspace root (pnpm + Turborepo)
├── packages/
│   ├── web/                   ← Next.js 16 app (@guardian/web)
│   ├── mcp/                   ← MCP server (@guardian/mcp-server)
│   ├── orchestrations/        ← Pure engine logic (@guardian/orchestrations)
│   ├── temporal/              ← Temporal.io adapter (@guardian/temporal)
│   ├── figma-plugin/          ← Figma plugin (@guardian/figma-plugin)
│   ├── figma-desktop-plugin/  ← Figma desktop plugin (@guardian/figma-desktop-plugin)
│   ├── figma-widget/          ← Figma widget (@guardian/figma-widget)
│   ├── bridge/                ← Shared bridge types (@guardian/bridge)
│   ├── electron-overlay/      ← macOS overlay (@guardian/electron-overlay)
│   ├── chrome-extension/      ← Chrome extension (@guardian/chrome-extension)
│   └── design-system-sample/  ← Example design system
├── logs/                      ← Dev logs (gitignored)
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

### Releases & versioning

The monorepo is versioned per-package using [Changesets](https://github.com/changesets/changesets), with two linked groups (Figma plugin/widget/bridge and Temporal orchestrations/worker). Run `pnpm changeset` after any change to record the bump level and changelog note. See [`docs/architecture/versioning.md`](docs/architecture/versioning.md) for the full workflow, the GitHub Actions setup, and how Changesets interacts with the Vercel deploy pipeline.

## Demonstration of Concept

You can test the online application at https://preview.guardian.figdesys.com, in a limited demo mode.
You can use the GitHub and the Figma Console Sign In button to make comparison between the design and the code.
To make a comparison with Figma Console, you need to indicate the Figma file URL in the chat.

You can go further and connect your own Figma Desktop and your own code MCP server to test the full capabilities of the application by following the instructions below.

### Prerequisites

- Clone this repository with your favorite code editor (IDE)
- Install [pnpm](https://pnpm.io/installation) if not already available (`npm install -g pnpm`)
- Install all workspace dependencies from the repo root:
```bash
pnpm install
```
- Recommended: Start your Figma Desktop and enable the MCP server in parameters (default on port 3845)
- Optional: If your code editor supports an integrated MCP server like IntelliJ IDEA, enable it on port 3846
- Optional: If your code editor does not support an integrated MCP server, start one like:
```bash
sudo npm install -g supergateway @modelcontextprotocol/server-filesystem
npx supergateway --stdio "mcp-server-filesystem $(pwd)" --outputTransport streamableHttp --port 3846
```

### Getting Started

- Start the tunnel that redirects to your Figma/Code Desktop MCP securely in another terminal:
```bash
pnpm dev:proxy
```
- Copy the domain/secret you received from cloudflare, something like:
```bash
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   COPY your TUNEL_INFO and past it in parameters of:                         ║
║   https://ids-hackathon-2026-ds-ai-guardian.vercel.app/                      ║
║                                                                              ║
╠══════════════════════════════════════════════════════════════════════════════╣
║   TUNEL_INFO:                                                                ║
║   https://teeth-sorts-thank-louisiana.trycloudflare.com                      ║
║   OtzEHLz8eTZFn4h7fJaTh2/2QFws0gHpc/y7gbBctb0=                               ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```
- go to the online demo page: https://preview.guardian.figdesys.com
- Click on `Configure proxy` in the side panel `parameters` panel
- Paste the domain in the `Tunnel URL` field
- Paste the secret in the `Secret` field
- Save the configuration and test the AI Agent

## Development Testing

### Prerequisites

#### Install

- Clone this repository with your favorite code editor (IDE)
- Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (required for Supabase local)
- Install [pnpm](https://pnpm.io/installation) if not already available (`npm install -g pnpm`)
- Install all workspace dependencies from the repo root:
```bash
pnpm install
```

#### Setup your Keys and secret

- You have to create a file `.env.local` that is inspired by `.env.example`:
```bash
cp .env.example .env.local
```
- Then change the values in the `.env.local` file as follows:
```bash
XAI_API_KEY=XAI_API_KEY
MCP_TUNNEL_SECRET=YOUR_PRIVATE_SECRET

# Figma APP used for Oauth credentials (create one in https://www.figma.com/developers/apps)
FIGMA_CLIENT_ID=FIGMA_CLIENT_ID
FIGMA_CLIENT_SECRET=FIGMA_CLIENT_SECRET

GITHUB_CLIENT_ID=GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=GITHUB_CLIENT_SECRET
```

#### Database — Supabase

Guardian uses [Supabase](https://supabase.com/) for authentication, data storage, and row-level security.

**Local development** uses Supabase local (Docker-based). Make sure Docker Desktop is running, then:

```bash
pnpm dev:supabase        # Start Supabase local (runs in background via Docker)
pnpm dev:supabase:stop   # Stop Supabase local
```

A seed file (`supabase/seed.sql`) creates a default admin account:
- **Email:** `admin@guardian.local`
- **Password:** `admin`

`pnpm dev` automatically checks that Supabase local is running and offers to start it if not.

Supabase local includes **Mailpit** (`http://127.0.0.1:54324`), a local email inbox that captures all emails (invite links, password resets, etc.) instead of sending them. Use it to test the invite flow.

**Production** uses a hosted Supabase project. The admin account must be created manually:
1. Go to **Supabase Dashboard > Authentication > Users > Add user**
2. Enter email and password, check **Auto Confirm**
3. Click the user, **Edit user metadata**, add: `{"is_admin": true, "profile_completed": true}`
4. Save

**Beta access:** The platform is invite-only. Admins invite users from `/admin/invite`. Invited users receive a magic link email, then complete their profile (name, role, Terms acceptance) before accessing the platform.

#### MCP of code editor

- If your code editor supports an integrated MCP server like IntelliJ IDEA, enable it on port 3846
- If your code editor does not support an integrated MCP server, starts one like :
```bash
sudo npm install -g supergateway @modelcontextprotocol/server-filesystem
npx supergateway --stdio "mcp-server-filesystem $(pwd)" --outputTransport streamableHttp --port 3846
```

#### MCP of Figma Desktop

Be sure to enable the MCP integration in your Figma Desktop application on port 3845.

### Getting Started

Run the full development stack with a single command:

```bash
pnpm install
pnpm dev
```

This starts **everything**:

| Service | Port | Package |
|---|---|---|
| Supabase Studio (admin UI) | 54323 | - (Docker, started separately) |
| Supabase Mailpit (email inbox) | 54324 | - (Docker, started separately) |
| Supabase (API) | 54321 | - (Docker, started separately) |
| Supabase (DB) | 54322 | - (Docker, started separately) |
| Next.js webapp | 3000 | `@guardian/web` |
| MCP server (HTTP) | 3847 | `@guardian/mcp-server` — external MCP clients (Claude Code, Cursor…) authenticate via OAuth 2.1 + DCR, see [`docs/architecture/mcp-oauth.md`](docs/architecture/mcp-oauth.md) |
| Temporal dev server | 7233 | - |
| Temporal worker | - | `@guardian/temporal` |
| Figma plugin | - | `@guardian/figma-plugin` |
| Figma desktop plugin | - | `@guardian/figma-desktop-plugin` |
| Figma widget | - | `@guardian/figma-widget` |
| Bridge types | - | `@guardian/bridge` |
| Electron overlay | - | `@guardian/electron-overlay` |

#### Logs

All output is printed to the terminal **and** written to `logs/dev.log` (gitignored).

#### Production-mode web (perf testing)

```bash
pnpm dev:web-prod
```

Launches the full dev stack like `pnpm dev`, but `@guardian/web` is built
with `next build` and served with `next start` instead of running under
`next dev`. Everything else (Temporal server, Temporal worker, MCP server,
Figma plugins, bridge, overlay) still runs in dev/watch mode.

Use this when profiling the web app — dev mode adds heavy React overhead
(`jsxDEV` stack capture, `createTask` instrumentation, double-render under
StrictMode) that masks real bottlenecks in Chrome DevTools traces. Prod
mode strips all of it.

Caveats:
- First build takes ~30-60s; subsequent rebuilds are incremental.
- **No HMR on `@guardian/web`** — you have to stop (Ctrl+C) and re-run the
  script to pick up code changes.
- Port 3000 must be free before launching (the script will abort with a
  hint if it's occupied).

#### Individual services

```bash
pnpm dev:supabase          # Supabase local (Docker, runs in background)
pnpm dev:supabase:stop     # Stop Supabase local (data preserved)
pnpm dev:supabase:reset    # Wipe all data and restart fresh (re-applies migrations + seed)
pnpm dev:web               # Next.js only
pnpm dev:mcp               # MCP server only
pnpm dev:temporal           # Temporal worker only (tsx --watch, auto-restarts on code changes)
pnpm dev:temporal-server    # Temporal dev server only
pnpm dev:overlay            # Electron overlay only
pnpm dev:extension          # Chrome extension (watch)
```

#### Preview mode

`pnpm dev:preview` launches a lean dev stack for testing the Figma plugin against the preview cloud environment. Only the packages that need local building are started — the webapp, MCP server, database and orchestration server are all in the cloud.

##### Quick start (new developer)

1. Clone the repo and install dependencies:
   ```bash
   git clone <repo-url> && cd IDS-hackathon-2026
   pnpm install
   ```

2. Get the env files from an existing team member:
   - `.env.local` — local defaults (Figma OAuth keys, MCP URLs)
   - `.env.preview` — cloud credentials (Temporal Cloud, Supabase Cloud)

3. Start the preview stack:
   ```bash
   pnpm dev:preview
   ```
   You should see: `☁  Preview mode` with the Temporal and Supabase cloud addresses.

4. Import the plugin in Figma Desktop:
   - Plugins > Development > **Import plugin from manifest...**
   - Select `packages/figma-desktop-plugin/manifest.json`

5. Open the plugin from the Plugins > Development menu. It loads `preview.guardian.figdesys.com` in the iframe.

6. Log in with your beta account (invite-only). The webapp, chat, and collabs all run against the preview cloud.

##### What runs locally

```bash
pnpm dev              # full local stack (all packages + local Temporal + local Supabase)
pnpm dev:preview      # lean preview stack (see below)
```

| Process | Package | Purpose |
|---|---|---|
| Figma plugin (watch) | `@guardian/figma-plugin` | Build `dist/ui.html` → `preview.guardian.figdesys.com` |
| Desktop plugin (watch) | `@guardian/figma-desktop-plugin` | Copy from plugin build |
| Widget (watch) | `@guardian/figma-widget` | Copy from plugin build |
| Bridge (tsc watch) | `@guardian/bridge` | Shared types |
| Electron overlay | `@guardian/electron-overlay` | Polls `preview.guardian.figdesys.com/api/guardian/status` (via `GUARDIAN_CLOUD_URL`) |

##### What runs in the cloud

- `@guardian/web` — webapp on `preview.guardian.figdesys.com` (Vercel)
- `@guardian/mcp-server` — MCP server on Vercel
- `@guardian/temporal` — Temporal worker on Railway (always-on)
- Temporal server — Temporal Cloud
- Supabase — Supabase Cloud

##### Notes

- **First connection can be slow**: the Figma plugin and the Chrome tab may take a few seconds to see each other via Supabase Realtime Presence (remote latency vs instant in local). A "connecting..." badge is shown during this time, and a fallback DB poll kicks in after 5s if Realtime hasn't synced yet.
- **After rebuilding the plugin**: close and reopen it in Figma to pick up the new `dist/ui.html`.

#### Figma plugin build

The webapp URL loaded in the plugin iframe is configurable via the `GUARDIAN_URL` env var (default: `http://localhost:3000`):

```bash
pnpm --filter @guardian/figma-plugin build            # localhost (default)
pnpm --filter @guardian/figma-plugin build:preview     # preview.guardian.figdesys.com
pnpm --filter @guardian/figma-plugin build:prod        # guardian.figdesys.com
```

All plugin variants (`figma-plugin`, `figma-desktop-plugin`, `figma-widget`) respect `GUARDIAN_URL`.

#### Tests

```bash
pnpm --filter @guardian/orchestrations test   # Orchestration engine tests
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Chat API

The application exposes a single endpoint at `POST /api/chat` that powers the conversational agent API.

### Request

The endpoint expects a JSON body with the following fields:

| Field | Type | Description |
|---|---|---|
| `messages` | `array` | Conversation history in the AI SDK message format. |
| `figmaMcpUrl` | `string` | URL of the Figma MCP server (e.g., `http://127.0.0.1:3845/sse` or `https://mcp.figma.com/mcp`). |
| `figmaAccessToken` | `string` | Optional Figma access token for authentication. |
| `codeProjectPath` | `string` | URL of the filesystem MCP server pointing to the code project (e.g., `http://127.0.0.1:3846/sse`). |
| `figmaOAuth` | `boolean` | Enable OAuth authentication for Figma MCP. |
| `model` | `string` | Model to use: `grok-4-1-fast-reasoning` (default) or `grok-4-1-fast-non-reasoning`. |
| `selectedNode` | `string` | URL of the currently selected Figma node (from host application). |
| `tunnelSecret` | `string` | Optional secret token for tunnel authentication. |

### Headers

| Header | Description |
|---|---|
| `X-MCP-Code-URL` | Optional fallback URL for code MCP server (used if `codeProjectPath` is empty). |

### How it works

1. **MCP connection** — For each provided URL (`figmaMcpUrl`, `codeProjectPath`), the server connects to the corresponding MCP server. Supports both SSE and HTTP transports (auto-detected). Connections are cached globally with healthchecks and automatic reconnection. Cached connections expire after 2 minutes (`MAX_AGE_MS`).
2. **Authentication** — Figma MCP supports multiple auth modes:
   - OAuth via `figmaOAuth` flag using cookie-based tokens
   - Bearer token via `figmaAccessToken` or environment variable
   - Tunnel secret via `tunnelSecret` header
3. **Tool discovery** — Once connected, all available MCP tools are fetched from both servers, prefixed (`figma_*`, `code_*`), and merged into a single tool map with retry logic.
4. **System prompt** — The base system prompt (`GUARDIAN_SYSTEM_PROMPT` defined in `src/lib/system-prompt.ts`) is augmented at runtime with:
   - Any MCP connection errors, so the model can inform the user.
   - The list of available MCP tool names.
   - Selected Figma node information (if provided).
5. **Streaming with keepalive** — While MCP connections are being established, the server sends SSE keepalive pings every 5 seconds to prevent timeouts. MCP status updates (`[MCP_STATUS:connecting]`, `[MCP_STATUS:connected]`) are streamed to the client.
6. **Streaming response** — The request is forwarded to the model via `@ai-sdk/xai` using `streamText`. The model can invoke MCP tools autonomously up to 10 steps (`stopWhen: stepCountIs(10)`). Additional built-in tool: `web_search`.
7. **Response format** — The streamed result is returned as a UI message stream, consumed on the client side by the `useChat` hook from `@ai-sdk/react`.

### Response

The endpoint returns a streaming SSE response with the following message types:

| Type | Description |
|---|---|
| `start` | Stream initialization |
| `text-start` | Beginning of a text message (includes `id`) |
| `text-delta` | Text chunk (includes `id` and `delta`) |
| `text-end` | End of a text message (includes `id`) |
| `ping` | Keepalive ping during MCP connection (includes `timestamp`) |
| `finish` | Stream completion (includes `finishReason`) |

Special text blocks:
- `[MCP_STATUS:connecting]` — MCP connection in progress
- `[MCP_STATUS:connected]` — MCP connection successful
- `[MCP_ERROR_BLOCK]...[/MCP_ERROR_BLOCK]` — MCP connection errors

### Error Handling

- If an MCP server connection fails, the error is captured and included in the system prompt. The model will inform the user about which MCP server is unavailable and continue operating with the available tools.
- Tool execution failures trigger automatic reconnection and retry once before failing.
- Global MCP connection timeout: 120 seconds.
- Tool timeout: 60 seconds.
- Connection timeout: 30 seconds.


## Deploy on Vercel

The easiest way to deploy the web app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme).

The `vercel.json` at the repo root sets `rootDirectory` to `packages/web`, so Vercel automatically detects the Next.js app in the monorepo without extra configuration.

Check out the [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

### Demo Deployment

You can test an already deployed package on https://ids-hackathon-2026-ds-ai-guardian.vercel.app/.


# troubleshoots

## MCP Figma connections online with `mcp.figma.com/mcp`

### OAuth Flow Diagnostics and Fixes

#### Root Cause of the 401 Error
The Figma MCP server (`mcp.figma.com/mcp`) **only accepts tokens obtained via the native MCP OAuth flow with the `mcp:connect` scope**. Standard tokens (obtained via `/oauth` with scopes like `file_content:read`) and Personal Access Tokens (PAT) are systematically rejected with HTTP 401.

The `mcp:connect` scope is **not available in the Figma developer portal** — it does not appear in the app scope settings. This scope is exclusively reserved for **whitelisted MCP clients** (VS Code, Cursor, Claude Code, Windsurf, Codex). Third-party apps like Guardian cannot obtain it.

#### Figma's Whitelist Approach (as of March 2026)

Figma uses a **client whitelist** for MCP access instead of open Dynamic Client Registration (DCR):

- **Whitelisted clients** (VS Code, Cursor, Claude Code, etc.) have pre-approved DCR — their registration at `api.figma.com/v1/oauth/mcp/register` succeeds
- **Third-party apps** get **403 Forbidden** on the DCR endpoint
- There is an access request form (Asana) to ask Figma for whitelisting, but approval is not guaranteed (beta program)
- The `mcp:connect` scope is invisible in the Figma developer portal scope settings

#### Figma OAuth App Visibility

Figma OAuth apps have three states:

| State | Who can use it | Review required |
|-------|---------------|-----------------|
| **Development (draft)** | Only the creator + plan admins | No |
| **Published Private** | All members of the associated team/org | No |
| **Published Public** | Everyone | Yes (Figma review) |

**Important:** A Private app is invisible to accounts outside the team/org — Figma returns "OAuth app with client id ... doesn't exist" (not "access denied").

#### Redirect URI Matching

The `redirect_uri` sent in the OAuth request must match **exactly** what is registered in the Figma app. Common pitfall: `localhost` vs `127.0.0.1` are different hosts. The `NEXT_PUBLIC_BASE_URL` env var controls the canonical host used for redirect URIs (via `get-base-url.ts`).

#### Implemented Changes

1. **Dynamic Client Registration Route** (`src/app/api/auth/figma-mcp/register/route.ts`) — Attempts dynamic registration with Figma. If DCR succeeds, the dynamic `client_id` is stored in a cookie and used for the native MCP flow. Currently returns 403 for non-whitelisted apps.

2. **Dual Authentication Mode** (`src/app/api/auth/figma-mcp/route.ts` and `callback/route.ts`):
   - **Native MCP Mode**: If a DCR client is available, uses `mcp.figma.com` as the issuer with the `mcp:connect` scope. The obtained token will work with the MCP server.
   - **Standard Mode (fallback)**: If DCR fails, uses standard scopes and the `/oauth` endpoint. Figma authentication works but the token cannot access the cloud MCP server.

3. **Enhanced "Sign in with Figma" Button** (`src/app/page.tsx`) — The button first attempts DCR in the background before redirecting to the OAuth flow.

4. **Chat Route Cleanup** (`src/app/api/chat/route.ts`) — Debug code removed, simplified logic using `authProvider` via the SDK, cleaned headers (no `X-Auth-Token` to figma.com).

5. **Token Normalization** (`src/lib/figma-mcp-oauth.ts`) — The `tokens()` method ensures the `access_token` field is present in snake_case for the SDK.

6. **Canonical Host Redirect** (`src/lib/get-base-url.ts`) — Server-side `getBaseUrl()` now prefers `NEXT_PUBLIC_BASE_URL` env var to ensure the redirect URI matches the registered OAuth domain (e.g. `127.0.0.1` vs `localhost`).

#### Known Limitation
The Figma remote MCP server (`mcp.figma.com/mcp`) is **not accessible to third-party apps** as of March 2026. The DCR endpoint returns 403 Forbidden and the `mcp:connect` scope is not available in the developer portal. This is a deliberate restriction by Figma — only pre-approved clients can use the remote MCP. Alternatives: use the **Desktop MCP** (`localhost:3845`) or the **Figma REST API** with standard OAuth tokens.