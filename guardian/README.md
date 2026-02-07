This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Chat API

The application exposes a single endpoint at `POST /api/chat` that powers the conversational UI.

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
4. **Streaming response** — The request is forwarded to the `grok-4-fast-non-reasoning` model via `@ai-sdk/xai` using `streamText`. The model can invoke MCP tools autonomously up to 10 steps (`stopWhen: stepCountIs(10)`).
5. **Response format** — The streamed result is returned as a UI message stream (`toUIMessageStreamResponse()`), consumed on the client side by the `useChat` hook from `@ai-sdk/react`.

### Response

The endpoint returns a streaming response in the Vercel AI SDK UI message stream format. The client consumes it via `DefaultChatTransport` configured with the same `figmaMcpUrl` and `codeProjectPath` values passed in the request body.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
