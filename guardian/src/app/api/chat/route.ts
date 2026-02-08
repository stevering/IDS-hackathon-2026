import { xai } from "@ai-sdk/xai";
import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { GUARDIAN_SYSTEM_PROMPT } from "@/lib/system-prompt";
import { cookies } from "next/headers";

export const maxDuration = 120;

const TOOL_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 10_000;
const MAX_AGE_MS = 2 * 60_000;

function ensureSsePath(url: string): string {
  return url.trim().replace(/\/+$/, "");
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
  __mcpClients?: Map<string, CachedMCP>;
};
if (!globalCache.__mcpClients) {
  globalCache.__mcpClients = new Map();
}
const mcpClients = globalCache.__mcpClients;

async function connectMCP(url: string, label: string, headers?: Record<string, string>): Promise<CachedMCP> {
  const cleanUrl = ensureSsePath(url);

  let client: MCPClient;
  try {
    console.log(`[${label}] Connecting to MCP at ${cleanUrl} (trying SSE) …`);
    client = await withTimeout(
      createMCPClient({ transport: { type: "sse", url: cleanUrl, headers } }),
      CONNECTION_TIMEOUT_MS,
      `MCP SSE connection to ${label}`,
    );
  } catch (sseError) {
    const msg = sseError instanceof Error ? sseError.message : String(sseError);
    console.warn(`[${label}] SSE transport failed (${msg}), falling back to streamable HTTP …`);
    client = await withTimeout(
      createMCPClient({ transport: { type: "http", url: cleanUrl, headers } }),
      CONNECTION_TIMEOUT_MS,
      `MCP HTTP connection to ${label}`,
    );
  }

  const tools = await withTimeout(
    client.tools(),
    CONNECTION_TIMEOUT_MS,
    `Tool discovery for ${label}`,
  );
  console.log(`[${label}] Connected — tools:`, Object.keys(tools));
  const entry: CachedMCP = { client, tools, connectedAt: Date.now() };
  mcpClients.set(cleanUrl, entry);
  return entry;
}

async function connectMCPHttp(url: string, label: string, headers?: Record<string, string>): Promise<CachedMCP> {
  const cleanUrl = ensureSsePath(url);
  console.log(`[${label}] Connecting to MCP at ${cleanUrl} (HTTP only) …`);
  const client = await withTimeout(
    createMCPClient({ transport: { type: "http", url: cleanUrl, headers } }),
    CONNECTION_TIMEOUT_MS,
    `MCP HTTP connection to ${label}`,
  );
  const tools = await withTimeout(
    client.tools(),
    CONNECTION_TIMEOUT_MS,
    `Tool discovery for ${label}`,
  );
  console.log(`[${label}] Connected (HTTP) — tools:`, Object.keys(tools));
  const entry: CachedMCP = { client, tools, connectedAt: Date.now() };
  mcpClients.set(cleanUrl, entry);
  return entry;
}

async function evict(url: string) {
  const cleanUrl = ensureSsePath(url);
  const cached = mcpClients.get(cleanUrl);
  mcpClients.delete(cleanUrl);
  if (cached) {
    try { await cached.client.close(); } catch { /* ignore */ }
  }
}

async function getOrConnect(url: string, label: string, headers?: Record<string, string>, forceHttp?: boolean): Promise<CachedMCP> {
  const cleanUrl = ensureSsePath(url);
  const cached = mcpClients.get(cleanUrl);

  if (cached && Date.now() - cached.connectedAt < MAX_AGE_MS) {
    return cached;
  }

  if (cached) {
    console.log(`[${label}] Connection stale (age ${Math.round((Date.now() - cached.connectedAt) / 1000)}s), reconnecting…`);
    await evict(url);
  }

  return forceHttp ? connectMCPHttp(url, label, headers) : connectMCP(url, label, headers);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapToolsWithRetry(tools: Record<string, any>, url: string, label: string, headers?: Record<string, string>): Record<string, any> {
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
            const fresh = await connectMCP(url, label, headers);
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
  const { messages, figmaMcpUrl, figmaAccessToken, codeProjectPath, figmaOAuth, model } = await req.json();

  let allTools: Record<string, unknown> = {};
  const mcpErrors: string[] = [];

  if (figmaMcpUrl) {
    const cookieStore = await cookies();
    const oauthToken = cookieStore.get("figma_access_token")?.value;
    const token = figmaAccessToken || oauthToken || process.env.FIGMA_ACCESS_TOKEN;
    const figmaHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
    const useOAuthHttp = !!(figmaOAuth && oauthToken);
    const effectiveUrl = useOAuthHttp ? "https://mcp.figma.com/mcp" : figmaMcpUrl;
    try {
      const { tools } = await getOrConnect(effectiveUrl, "Figma", figmaHeaders, useOAuthHttp);
      const prefixedTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [`figma_${name}`, tool])
      );
      allTools = { ...allTools, ...wrapToolsWithRetry(prefixedTools, effectiveUrl, "Figma", figmaHeaders) };

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Figma] MCP connection failed:", msg);
      await evict(effectiveUrl);
      mcpErrors.push(`Figma MCP connection failed (${ensureSsePath(effectiveUrl)}): ${msg}`);
    }
  }

  if (codeProjectPath) {
    try {
      const { tools } = await getOrConnect(codeProjectPath, "Code");
      const prefixedTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [`code_${name}`, tool])
      );
      allTools = { ...allTools, ...wrapToolsWithRetry(prefixedTools, codeProjectPath, "Code") };
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
    const figmaTools = Object.keys(allTools).filter(t => t.startsWith('figma_') || t.includes('figma'));
    const codeTools = Object.keys(allTools).filter(t => !figmaTools.includes(t));
    system += `\n\nAvailable MCP tools:
  - Figma MCP: ${figmaTools.join(", ")}
  - Code MCP: ${codeTools.join(", ")}`;
  }

  const result = streamText({
    model: xai(model === "grok-4-1-fast-non-reasoning" ? "grok-4-1-fast-non-reasoning" : "grok-4-1-fast-reasoning"),
    system,
    messages: await convertToModelMessages(messages),
    tools: allTools as Parameters<typeof streamText>[0]["tools"],
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse();
}
