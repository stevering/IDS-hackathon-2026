import { xai } from "@ai-sdk/xai";
import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { GUARDIAN_SYSTEM_PROMPT } from "@/lib/system-prompt";

export const maxDuration = 60;

function ensureSsePath(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/sse")) return trimmed;
  return `${trimmed}/sse`;
}

async function connectSSE(
  url: string,
  label: string,
): Promise<{ client: MCPClient; tools: Record<string, unknown> }> {
  const sseUrl = ensureSsePath(url);
  console.log(`[${label}] Connecting to MCP at ${sseUrl} …`);

  const client = await createMCPClient({
    transport: { type: "sse", url: sseUrl },
  });
  const tools = await client.tools();
  console.log(`[${label}] Connected — tools:`, Object.keys(tools));
  return { client, tools };
}

async function connectStdio(
  command: string,
  args: string[],
  label: string,
): Promise<{ client: MCPClient; tools: Record<string, unknown> }> {
  console.log(`[${label}] Spawning MCP via stdio: ${command} ${args.join(" ")} …`);

  const transport = new Experimental_StdioMCPTransport({ command, args });
  const client = await createMCPClient({ transport });
  const tools = await client.tools();
  console.log(`[${label}] Connected — tools:`, Object.keys(tools));
  return { client, tools };
}

export async function POST(req: Request) {
  const { messages, figmaMcpUrl, codeProjectPath } = await req.json();

  const mcpClients: MCPClient[] = [];
  let allTools: Record<string, unknown> = {};
  const mcpErrors: string[] = [];

  if (figmaMcpUrl) {
    try {
      const { client, tools } = await connectSSE(figmaMcpUrl, "Figma");
      mcpClients.push(client);
      allTools = { ...allTools, ...tools };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Figma] MCP connection failed:", msg);
      mcpErrors.push(`Figma MCP connection failed (${ensureSsePath(figmaMcpUrl)}): ${msg}`);
    }
  }

  if (codeProjectPath) {
    try {
      const { client, tools } = await connectStdio(
        "npx",
        ["-y", "@anthropic-ai/mcp-server-filesystem", codeProjectPath],
        "Code",
      );
      mcpClients.push(client);
      allTools = { ...allTools, ...tools };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Code] MCP connection failed:", msg);
      mcpErrors.push(`Code MCP (filesystem) connection failed for path "${codeProjectPath}": ${msg}`);
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
    onFinish: async () => {
      for (const client of mcpClients) {
        await client.close().catch(console.error);
      }
    },
  });

  return result.toUIMessageStreamResponse();
}