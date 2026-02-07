import { xai } from "@ai-sdk/xai";
import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { GUARDIAN_SYSTEM_PROMPT } from "@/lib/system-prompt";

export const maxDuration = 120;

const TOOL_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 10_000;
const MAX_AGE_MS = 2 * 60_000;

function ensureSsePath(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/sse")) return trimmed;
  return `${trimmed}/sse`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

type CachedMCP = {
  client: MCPClient;
  tools: Record<string, unknown>;
  connectedAt: number;
};

const globalCache = globalThis as unknown as {
  __mcpSseClients?: Map<string, CachedMCP>;
};
if (!globalCache.__mcpSseClients) {
  globalCache.__mcpSseClients = new Map();
}
const sseClients = globalCache.__mcpSseClients;

async function connectSSE(url: string, label: string): Promise<CachedMCP> {
  const sseUrl = ensureSsePath(url);
  console.log(`[${label}] Connecting to MCP at ${sseUrl} …`);
  const client = await withTimeout(
    createMCPClient({ transport: { type: "sse", url: sseUrl } }),
    CONNECTION_TIMEOUT_MS,
    `MCP connection to ${label}`,
  );
  const tools = await withTimeout(
    client.tools(),
    CONNECTION_TIMEOUT_MS,
    `Tool discovery for ${label}`,
  );
  console.log(`[${label}] Connected — tools:`, Object.keys(tools));
  const entry: CachedMCP = { client, tools, connectedAt: Date.now() };
  sseClients.set(sseUrl, entry);
  return entry;
}

async function evict(url: string) {
  const sseUrl = ensureSsePath(url);
  const cached = sseClients.get(sseUrl);
  sseClients.delete(sseUrl);
  if (cached) {
    try { await cached.client.close(); } catch { /* ignore */ }
  }
}

async function getOrConnectSSE(url: string, label: string): Promise<CachedMCP> {
  const sseUrl = ensureSsePath(url);
  const cached = sseClients.get(sseUrl);

  if (cached && Date.now() - cached.connectedAt < MAX_AGE_MS) {
    return cached;
  }

  if (cached) {
    console.log(`[${label}] Connection stale (age ${Math.round((Date.now() - cached.connectedAt) / 1000)}s), reconnecting…`);
    await evict(url);
  }

  return connectSSE(url, label);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapToolsWithRetry(tools: Record<string, any>, url: string, label: string): Record<string, any> {
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = {
      ...tool,
      execute: async (...args: unknown[]) => {
        try {
          return await withTimeout(
            tool.execute(...args),
            TOOL_TIMEOUT_MS,
            `Tool "${name}"`,
          );
        } catch (firstError) {
          console.warn(`[${label}] Tool "${name}" failed, reconnecting: ${firstError instanceof Error ? firstError.message : firstError}`);
          await evict(url);
          try {
            const fresh = await connectSSE(url, label);
            const freshTool = fresh.tools[name];
            if (!freshTool || typeof (freshTool as { execute?: unknown }).execute !== "function") {
              throw firstError;
            }
            return await withTimeout(
              (freshTool as { execute: (...a: unknown[]) => Promise<unknown> }).execute(...args),
              TOOL_TIMEOUT_MS,
              `Tool "${name}" (retry)`,
            );
          } catch {
            throw firstError;
          }
        }
      },
    };
  }
  return wrapped;
}

export async function POST(req: Request) {
  const { messages, figmaMcpUrl, codeProjectPath } = await req.json();

  let allTools: Record<string, unknown> = {};
  const mcpErrors: string[] = [];

  if (figmaMcpUrl) {
    try {
      const { tools } = await getOrConnectSSE(figmaMcpUrl, "Figma");
      allTools = { ...allTools, ...wrapToolsWithRetry(tools, figmaMcpUrl, "Figma") };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Figma] MCP connection failed:", msg);
      await evict(figmaMcpUrl);
      mcpErrors.push(`Figma MCP connection failed (${ensureSsePath(figmaMcpUrl)}): ${msg}`);
    }
  }

  if (codeProjectPath) {
    try {
      const { tools } = await getOrConnectSSE(codeProjectPath, "Code");
      allTools = { ...allTools, ...wrapToolsWithRetry(tools, codeProjectPath, "Code") };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Code] MCP connection failed:", msg);
      await evict(codeProjectPath);
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
