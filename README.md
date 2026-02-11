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

## Demonstration of Concept

You can test online the application

### Prerequisites

- clone this repository with your favorite code editor (IDE)
- If your code editor supports an integrated MCP server like Intellij Idea, enable it
- If your code editor does not support an integrated MCP server, starts one like :
```bash
supergateway --sse --port 3846 --cors --stdio "mcp-server-filesystem $(pwd)"
```
- Install dependencies:
```bash
npm install
```
- Start your Figma Desktop and enable the MCP server in parameters


### Getting Started

- start the tunnel that redirects to your Figma Desktop MCP securely:
```bash
npm run dev:proxy
```
- Copy the domain/secret you received from cloudflare (something like `https://wrap-leisure-contents-poster.trycloudflare.com`)
- go to the online demo page : https://ids-hackathon-2026-ds-ai-guardian.vercel.app/
- Click on "Configure proxy" in the side "parameters" panel
- Paste the domain in the `Tunnel URL` field
- Paste the secret in the `Secret` field
- Save the configuration and test the AI Agent

## Development Testing

### Prerequisites

#### Setup your xAI API KEY

You have to create a file `.env.local` that is inspired by `.env.example`:
```bash
cp .env.example .env.local
```

Then change the values in the `.env.local` file as follows:
```
XAI_API_KEY=your_xai_api_key_here
FIGMA_ACCESS_TOKEN=your_figma_personal_access_token_here
FIGMA_CLIENT_ID=FIGMA_CLIENT_ID
FIGMA_CLIENT_SECRET=FIGMA_CLIENT_SECRET
NEXT_PUBLIC_BASE_URL=http://127.0.0.1:3000
```

#### MCP of code editor

If you are running a development editor with an integrated MCP server like
Intellij idea:
- be sure the MCP server is enable on the good port (64342 by default)

If your code editor does not support an integrated MCP server :
Before starting the dev server project, launch the MCP filesystem gateway:

```bash
supergateway --sse --port 3846 --cors --stdio "mcp-server-filesystem $(pwd)"
```

#### MCP of Figma Desktop

Be sure to enable the MCP integration in your Figma Desktop application on port 3845.

### Getting Started

First, run the development server:

```bash
npm install
npm run dev
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
| `figmaMcpUrl` | `string` | SSE URL of the Figma MCP server (e.g. `http://127.0.0.1:3845/sse`). |
| `codeProjectPath` | `string` | SSE URL of the filesystem MCP server pointing to the code project (e.g. `http://[::1]:3846/sse`). |

### How it works

1. **MCP connection** — For each provided URL (`figmaMcpUrl`, `codeProjectPath`), the server connects to the corresponding MCP server over SSE using `@ai-sdk/mcp`. Connections are cached globally so subsequent requests reuse the same client. If a URL does not end with `/sse`, the suffix is appended automatically.
2. **Tool discovery** — Once connected, all available MCP tools are fetched from both servers and merged into a single tool map.
3. **System prompt** — The base system prompt (`GUARDIAN_SYSTEM_PROMPT` defined in `src/lib/system-prompt.ts`) is augmented at runtime with:
   - Any MCP connection errors, so the model can inform the user.
   - The list of available MCP tool names.
4. **Streaming response** — The request is forwarded to the `grok-4-1-fast-reasoning` model via `@ai-sdk/xai` using `streamText`. The model can invoke MCP tools autonomously up to 10 steps (`stopWhen: stepCountIs(10)`).
5. **Response format** — The streamed result is returned as a UI message stream (`toUIMessageStreamResponse()`), consumed on the client side by the `useChat` hook from `@ai-sdk/react`.

### Response

The endpoint returns a streaming response in the Vercel AI SDK UI message stream format. The client consumes it via `DefaultChatTransport` configured with the same `figmaMcpUrl` and `codeProjectPath` values passed in the request body.



## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

### Demo Deployment

You can test a already deployed package on https://ids-hackathon-2026-ds-ai-guardian.vercel.app/.


# troubleshoots

## MCP figma connections online

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