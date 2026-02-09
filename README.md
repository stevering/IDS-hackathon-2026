# DS AI GUARDIAN (TEAM CTRL_ALT_DESIGN)

## About the Hackathon

This project was developed as part of the **IDS Hackathon 2026**, an event aimed at exploring the possibilities of artificial intelligence in the field of design systems and UI/UX consistency.
💻 Hackathon [IDS page](https://www.intodesignsystems.com/hackathon)
🗳️ Into Design Systems [Website](https://www.intodesignsystems.com/)

## The Project

**DS AI Guardian** is an intelligent AI assistant designed to ensure consistency between Figma designs and their code implementation. The tool automatically analyzes design files and source code to detect discrepancies, suggest corrections, and maintain design system integrity.

🧩 Our project [on GitHub](https://github.com/stevering/IDS-hackathon-2026)
🎥 Check out our [live demo](youtube.com/live/hOUN5crsNVI?si=nqKLkrbhMVOiYt9V&t=3433)
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


## Prerequisites

### MCP of code editor

If you are running a development editor with an integrated MCP server like
Intellij idea:
- be sure the MCP server is enable on the good port (64342 by default)

If your code editor does not support an integrated MCP server :
Before starting the dev server project, launch the MCP filesystem gateway:

```bash
supergateway --sse --port 3846 --cors --stdio "mcp-server-filesystem $(pwd)"
```

### MCP of Figma Desktop

Be sure to enable the MCP integration in your Figma Desktop application on port 3845.

## Getting Started

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

## Learn More

🎥 Check out our [live demo](youtube.com/live/hOUN5crsNVI?si=nqKLkrbhMVOiYt9V&t=3433)
🧩 Our project [on GitHub](https://github.com/stevering/IDS-hackathon-2026)

💻 Hackathon [IDS page](https://www.intodesignsystems.com/hackathon)
🗳️ Into Design Systems [Website](https://www.intodesignsystems.com/)

Together, let's make design systems more reliable and maintainable! 💪


## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
