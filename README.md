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
/                              ← workspace root
├── packages/
│   ├── web/                   ← Next.js 16 app  (@guardian/web)
│   ├── mcp/                   ← MCP server       (@guardian/mcp-server)
│   └── design-system-sample/  ← Storybook        (@guardian/design-system-sample)
├── assets/, docs/, tools/     ← static assets & documentation
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## Demonstration of Concept

You can test online the application

### Prerequisites

- Clone this repository with your favorite code editor (IDE)
- Install [pnpm](https://pnpm.io/installation) if not already available (`npm install -g pnpm`)
- Install all workspace dependencies from the repo root:
```bash
pnpm install
```
- Optional: If your code editor supports an integrated MCP server like Intellij Idea, enable it on port 3846
- Optional: If your code editor does not support an integrated MCP server, start one like:
```bash
sudo npm install -g supergateway @modelcontextprotocol/server-filesystem
npx supergateway --stdio "mcp-server-filesystem $(pwd)" --outputTransport streamableHttp --port 3846
```
- Recommended: Start your Figma Desktop and enable the MCP server in parameters (default on port 3845)


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
- go to the online demo page: https://v2.guardian.figdesys.com
- Click on `Configure proxy` in the side panel `parameters` panel
- Paste the domain in the `Tunnel URL` field
- Paste the secret in the `Secret` field
- Save the configuration and test the AI Agent

## Development Testing

### Prerequisites

#### Install

- Clone this repository with your favorite code editor (IDE)
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
XAI_API_KEY=your_xai_api_key_here
MCP_TUNNEL_SECRET=YOUR_PRIVATE_SECRET
```

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

First, run the development server:

```bash
pnpm install
pnpm dev          # starts both web (port 3000) and MCP server (port 3847) via Turborepo
```

Or start each package individually:

```bash
pnpm dev:web      # Next.js only  → http://localhost:3000
pnpm dev:mcp      # MCP server only → port 3847
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.
This is for now the standalone webapp.
You can test everything in it.

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

## MCP figma connections online with `mcp.figma.com/mcp`

### OAuth Flow Diagnostics and Fixes

#### Root Cause of the 401 Error
The Figma MCP server (`mcp.figma.com/mcp`) **only accepts tokens obtained via the native MCP OAuth flow with the `mcp:connect` scope**. Standard tokens (obtained via `/oauth` with scopes like `file_content:read`) and Personal Access Tokens (PAT) are systematically rejected with HTTP 401.

The `mcp:connect` scope is only accessible to dynamically registered clients (Dynamic Client Registration / DCR). The static client (`FIGMA_CLIENT_ID` from the developer portal) cannot use this scope. The DCR endpoint (`api.figma.com/v1/oauth/mcp/register`) currently returns **403 Forbidden**, likely due to a restriction on Figma's side.

#### Implemented Changes

1. **Dynamic Client Registration Route** (`src/app/api/auth/figma-mcp/register/route.ts`) — New route that attempts dynamic registration with Figma. If DCR succeeds, the dynamic `client_id` is stored in a cookie and used for the native MCP flow.

2. **Dual Authentication Mode** (`src/app/api/auth/figma-mcp/route.ts` and `callback/route.ts`):
   - **Native MCP Mode**: If a DCR client is available, uses `mcp.figma.com` as the issuer with the `mcp:connect` scope. The obtained token will work with the MCP server.
   - **Standard Mode (fallback)**: If DCR fails, uses standard scopes and the `/oauth` endpoint. Figma authentication works but the token cannot access the cloud MCP server.

3. **Enhanced "Sign in with Figma" Button** (`src/app/page.tsx`) — The button first attempts DCR in the background before redirecting to the OAuth flow.

4. **Chat Route Cleanup** (`src/app/api/chat/route.ts`) — Debug code removed, simplified logic using `authProvider` via the SDK, cleaned headers (no `X-Auth-Token` to figma.com).

5. **Token Normalization** (`src/lib/figma-mcp-oauth.ts`) — The `tokens()` method ensures the `access_token` field is present in snake_case for the SDK.

#### Known Limitation
The Figma DCR endpoint currently returns 403 Forbidden. Until Figma unblocks this endpoint, the native MCP flow cannot work for third-party applications. Official clients (VS Code, Cursor, Claude Code) use the same DCR mechanism — this is a restriction on Figma's side.