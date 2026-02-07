import { xai } from "@ai-sdk/xai";
import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { GUARDIAN_SYSTEM_PROMPT } from "@/lib/system-prompt";

export const maxDuration = 60;

function ensureSsePath(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/sse")) return trimmed;
  return `${trimmed}/sse`;
}

type CachedMCP = { client: MCPClient; tools: Record<string, unknown> };

const globalCache = globalThis as unknown as {
  __mcpSseClients?: Map<string, CachedMCP>;
};
if (!globalCache.__mcpSseClients) {
  globalCache.__mcpSseClients = new Map();
}
const sseClients = globalCache.__mcpSseClients;

async function getOrConnectSSE(
  url: string,
  label: string,
): Promise<CachedMCP> {
  const sseUrl = ensureSsePath(url);

  const cached = sseClients.get(sseUrl);
  if (cached) {
    return cached;
  }

  console.log(`[${label}] Connecting to MCP at ${sseUrl} …`);
  const client = await createMCPClient({
    transport: { type: "sse", url: sseUrl },
  });
  const tools = await client.tools();
  console.log(`[${label}] Connected — tools:`, Object.keys(tools));
  const entry = { client, tools };
  sseClients.set(sseUrl, entry);
  return entry;
}

export async function POST(req: Request) {
  const { messages, figmaMcpUrl, codeProjectPath } = await req.json();

  let allTools: Record<string, unknown> = {};
  const mcpErrors: string[] = [];

  if (figmaMcpUrl) {
    try {
      const { tools } = await getOrConnectSSE(figmaMcpUrl, "Figma");
      allTools = { ...allTools, ...tools };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Figma] MCP connection failed:", msg);
      mcpErrors.push(`Figma MCP connection failed (${ensureSsePath(figmaMcpUrl)}): ${msg}`);
    }
  }

  if (codeProjectPath) {
    try {
      const { tools } = await getOrConnectSSE(codeProjectPath, "Code");
      allTools = { ...allTools, ...tools };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Code] MCP connection failed:", msg);
      mcpErrors.push(`Code MCP (filesystem) connection failed for "${codeProjectPath}": ${msg}`);
    }
  }

  let system = GUARDIAN_SYSTEM_PROMPT;
  if (mcpErrors.length > 0) {
    system += `\n\n⚠️ MCP CONNECTION ERRORS:\n${mcpErrors.join("\n")}\nTell the user about these connection errors so they can fix them.`;
  }
  if (Object.keys(allTools).length > 0) {
    system += `\n\nAvailable MCP tools: ${Object.keys(allTools).join(", ")}`;
  }

  const result = streamText({
    model: xai("grok-4-fast-non-reasoning"),
    system,
    messages: await convertToModelMessages(messages),
    tools: allTools as Parameters<typeof streamText>[0]["tools"],
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse();
}