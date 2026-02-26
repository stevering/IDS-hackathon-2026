import { xai } from "@ai-sdk/xai";
import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { GUARDIAN_SYSTEM_PROMPT } from "@/lib/system-prompt";
import { cookies } from "next/headers";
import {
  createFigmaMcpOAuthProvider,
  MCP_FIGMA_SERVER_URL,
  COOKIE_TOKENS,
} from "@/lib/figma-mcp-oauth";
import {
  createSouthleftMcpOAuthProvider,
  SOUTHLEFT_MCP_URL,
  SOUTHLEFT_COOKIE_TOKENS,
} from "@/lib/southleft-mcp-oauth";

import {
  createGithubMcpOAuthProvider,
  GITHUB_MCP_URL,
  GITHUB_COOKIE_TOKENS,
} from "@/lib/github-mcp-oauth";

export const maxDuration = 300; // 5 minutes to avoid Cloudflare timeout
export const dynamic = 'force-dynamic';

// Increase the body size limit for the chat API (20MB)
export const fetchCache = 'force-no-store';

const TOOL_TIMEOUT_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 30_000;
const MAX_AGE_MS = 2 * 60_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;
const STREAM_KEEPALIVE_MS = 5_000; // Send a ping every 5s during MCP connection
const MAX_STEPS = 20; // Maximum number of steps for the stream (limit to prevent infinite loops)

const encoder = new TextEncoder();

// Utility function to encode an SSE message in AI SDK format
function encodeSSEMessage(type: string, data: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, ...data })}

`;
}

// Create a keepalive stream that sends pings during MCP connection
function createKeepaliveStream(
  mcpConnectionPromise: Promise<{ allTools: Record<string, unknown>; mcpErrors: string[] }>,
  modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>,
  system: string,
  model: string
): ReadableStream {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const startTime = Date.now();
      let keepaliveInterval: NodeJS.Timeout | null = null;
      let isMcpReady = false;

      // Start the stream
      controller.enqueue(encoder.encode(encodeSSEMessage("start", {})));

      // Send an initial message to indicate MCP connection
      const statusId = `mcp-status-${Date.now()}`;
      controller.enqueue(encoder.encode(encodeSSEMessage("text-start", { id: statusId })));
      controller.enqueue(encoder.encode(encodeSSEMessage("text-delta", {
        id: statusId,
        delta: "[MCP_STATUS:connecting]"
      })));

      // Function to send keepalive pings
      const sendKeepalive = () => {
        if (!isMcpReady && controller.desiredSize !== null) {
          controller.enqueue(encoder.encode(encodeSSEMessage("ping", { timestamp: Date.now() })));
        }
      };

      // Start pings every 5 seconds
      keepaliveInterval = setInterval(sendKeepalive, STREAM_KEEPALIVE_MS);

      try {
        // Wait for MCP connection with global timeout
        const mcpResult = await Promise.race([
          mcpConnectionPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("MCP connection global timeout")), 120_000)
          )
        ]);

        isMcpReady = true;
        if (keepaliveInterval) clearInterval(keepaliveInterval);

        const { mcpErrors } = mcpResult;

        // Update MCP status
        // Update MCP status - hide the loader
        controller.enqueue(encoder.encode(encodeSSEMessage("text-delta", {
          id: statusId,
          delta: "[MCP_STATUS:connected]"
        })));
        controller.enqueue(encoder.encode(encodeSSEMessage("text-end", { id: statusId })));

        // If errors, send them in the format expected by the client
        if (mcpErrors.length > 0) {
          console.log("[Chat] Sending MCP errors to client:", mcpErrors);
          const errorId = `mcp-error-${Date.now()}`;
          const errorText = mcpErrors.join("\n");
          controller.enqueue(encoder.encode(encodeSSEMessage("text-start", { id: errorId })));
          controller.enqueue(encoder.encode(encodeSSEMessage("text-delta", {
            id: errorId,
            delta: `\n\n[MCP_ERROR_BLOCK]${errorText}[/MCP_ERROR_BLOCK]\n\n`
          })));
          controller.enqueue(encoder.encode(encodeSSEMessage("text-end", { id: errorId })));
        }

          // Promise to capture the exact stream result (finish reason and step count)
          let streamFinishedResolve: (result: { finishReason: string; steps: { length: number } }) => void;
          const streamFinishedPromise = new Promise<{ finishReason: string; steps: { length: number } }>((resolve) => {
            streamFinishedResolve = resolve;
          });

          // Now start streamText with MCP tools
         const result = streamText({
           model: xai.responses(model === "grok-4-1-fast-non-reasoning" ? "grok-4-1-fast-non-reasoning" : "grok-4-1-fast-reasoning"),
           system,
           messages: modelMessages,
           tools: {
             ...mcpResult.allTools,
             web_search: xai.tools.webSearch(),
           } as Parameters<typeof streamText>[0]["tools"],
            stopWhen: stepCountIs(MAX_STEPS),
           onStepFinish: (step) => {
             if (step.toolCalls.length > 0) {
               console.log("[Chat] Tool calls:", step.toolCalls.map(t => t));
             }
             if (step.toolResults.length > 0) {
               console.log("[Chat] Tool results:", step.toolCalls.map(t => t));
             }
           },
           onFinish: (result) => {
              console.log("[Chat] Keepalive stream finished with reason:", result.finishReason);
              if (result.finishReason === 'stop' && result.steps.length >= MAX_STEPS) {
                console.warn(`[Chat] Keepalive stream stopped due to max steps (${MAX_STEPS}) - response may be truncated`);
              }
             console.log("[Chat] Keepalive stream finished with reason:", result.finishReason, "steps:", result.steps.length);
             streamFinishedResolve({ finishReason: result.finishReason, steps: result.steps });
           },
         });

          // Pipe the streamText stream to our controller
          const aiStream = result.toUIMessageStreamResponse().body;
          if (aiStream) {
            const reader = aiStream.getReader();
            let lastTextDeltaId: string | null = null;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = new TextDecoder().decode(value);

                // Track the last text-delta id to inject marker if needed
                if (text.includes('"type":"text-delta"')) {
                  const match = text.match(/"id":"([^"]+)"/);
                  if (match) lastTextDeltaId = match[1];
                }

                controller.enqueue(value);
              }
            } finally {
              reader.releaseLock();
            }

            // Wait for the exact stream result to detect step limit
           const streamResult = await streamFinishedPromise;
            const hitStepLimit = streamResult.finishReason === 'stop' && streamResult.steps.length >= MAX_STEPS;
           
           if (hitStepLimit && lastTextDeltaId) {
             console.log("[Chat] Step limit reached (", streamResult.steps.length, "steps), adding continuation marker");
             const contId = "continuation_3f77d6f2-09a6-bd03-7bc8-286d72bd0f9f";
             const markerStart = encoder.encode(`data: ${JSON.stringify({ type: "text-start", id: contId })}\n\n`);
             const markerDelta = encoder.encode(`data: ${JSON.stringify({ type: "text-delta", id: contId, delta: "[CONTINUATION_AVAILABLE]" })}\n\n`);
             const markerEnd = encoder.encode(`data: ${JSON.stringify({ type: "text-end", id: contId })}\n\n`);
             controller.enqueue(markerStart);
             controller.enqueue(markerDelta);
             controller.enqueue(markerEnd);
             controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
             console.log("[Chat] Added CONTINUATION_AVAILABLE marker and [DONE]");
           }
          }

       } catch (error) {
        // MCP connection error
        if (keepaliveInterval) clearInterval(keepaliveInterval);

        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error("[Chat] MCP connection failed:", errorMsg);

        controller.enqueue(encoder.encode(encodeSSEMessage("text", {
          content: `❌ MCP connection error: ${errorMsg}`
        })));
        controller.enqueue(encoder.encode(encodeSSEMessage("finish", { finishReason: "error" })));

      } finally {
        controller.close();
      }
    },

    cancel() {
      // Cleanup if the client closes the connection
      console.log("[Chat] Stream cancelled by client");
    }
  });
}

function detectTransport(url: string): "sse" | "http" {
  if (url.includes("/sse")) return "sse";
  return "http";
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

async function healthcheckMCP(client: MCPClient, label: string): Promise<boolean> {
  try {
    // Check that the client can list tools (lightweight ping)
    await withTimeout(
      client.tools(),
      HEALTHCHECK_TIMEOUT_MS,
      `Healthcheck for ${label}`,
    );
    return true;
  } catch (error) {
    console.warn(`[${label}] Healthcheck failed:`, error instanceof Error ? error.message : error);
    return false;
  }
}

async function connectMCPAuto(url: string, label: string, headers?: Record<string, string>): Promise<CachedMCP> {
  const transport = detectTransport(url);
  console.log(`[${label}] Connecting to MCP at ${url} (${transport.toUpperCase()}) …`);
  const client = await withTimeout(
    createMCPClient({ transport: { type: transport, url, headers } }),
    CONNECTION_TIMEOUT_MS,
    `MCP ${transport.toUpperCase()} connection to ${label}`,
  );
  const tools = await withTimeout(
    client.tools(),
    CONNECTION_TIMEOUT_MS,
    `Tool discovery for ${label}`,
  );
  console.log(`[${label}] Connected (${transport.toUpperCase()}) — tools:`, Object.keys(tools));
  const entry: CachedMCP = { client, tools, connectedAt: Date.now() };
  mcpClients.set(url, entry);
  return entry;
}

async function evict(url: string) {
  const cached = mcpClients.get(url);
  if (cached) {
    mcpClients.delete(url);
    try { await cached.client.close(); } catch { /* ignore */ }
  }
}

async function getOrConnect(url: string, label: string, headers?: Record<string, string>): Promise<CachedMCP> {
  const cached = mcpClients.get(url);

  // If we have a cache, verify it's still valid with a healthcheck
  if (cached) {
    const isHealthy = await healthcheckMCP(cached.client, label);
    if (isHealthy && Date.now() - cached.connectedAt < MAX_AGE_MS) {
      console.log(`[${label}] Connection healthy (age ${Math.round((Date.now() - cached.connectedAt) / 1000)}s)`);
      return cached;
    }
    console.log(`[${label}] Connection unhealthy or stale (age ${Math.round((Date.now() - cached.connectedAt) / 1000)}s), reconnecting…`);
    await evict(url);
  }

  return connectMCPAuto(url, label, headers);
}

async function connectMCPWithAuth(url: string, label: string, authProvider: import("@ai-sdk/mcp").OAuthClientProvider, headers?: Record<string, string>): Promise<CachedMCP> {
  const transport = detectTransport(url);
  console.log(`[${label}] Connecting to MCP at ${url} (${transport.toUpperCase()} + authProvider) …`);
  const client = await withTimeout(
    createMCPClient({ transport: { type: transport, url, authProvider, headers } }),
    CONNECTION_TIMEOUT_MS,
    `MCP ${transport.toUpperCase()}+Auth connection to ${label}`,
  );
  const tools = await withTimeout(
    client.tools(),
    CONNECTION_TIMEOUT_MS,
    `Tool discovery for ${label}`,
  );
  console.log(`[${label}] Connected (${transport.toUpperCase()}+Auth) — tools:`, Object.keys(tools));
  const entry: CachedMCP = { client, tools, connectedAt: Date.now() };
  mcpClients.set(url, entry);
  return entry;
}

async function getOrConnectWithAuth(url: string, label: string, authProvider: import("@ai-sdk/mcp").OAuthClientProvider, headers?: Record<string, string>): Promise<CachedMCP> {
  const cached = mcpClients.get(url);

  // If we have a cache, verify it's still valid with a healthcheck
  if (cached) {
    const isHealthy = await healthcheckMCP(cached.client, label);
    if (isHealthy && Date.now() - cached.connectedAt < MAX_AGE_MS) {
      console.log(`[${label}] Connection healthy`);
      return cached;
    }
    console.log(`[${label}] Connection unhealthy or stale, reconnecting…`);
    await evict(url);
  }

  return connectMCPWithAuth(url, label, authProvider, headers);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapToolsWithRetry(tools: Record<string, any>, url: string, label: string, headers?: Record<string, string>): Record<string, any> {
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = {
      ...tool,
      execute: async (...args: unknown[]) => {
        try {
          // Inject default excludePatterns for directory tree tools
          let finalArgs = args;
          if ((name === 'code_directory_tree' || name === 'directory_tree') && args.length > 0) {
            const arg0 = args[0] as Record<string, unknown>;
            if (!arg0.excludePatterns) {
              finalArgs = [{
                ...arg0,
                excludePatterns: [".git", ".idea", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", "coverage", ".turbo"]
              }];
            }
          }
          return await withTimeout(
            tool.execute(...finalArgs),
            TOOL_TIMEOUT_MS,
            `Tool "${name}"`,
          );
        } catch (firstError) {
          console.warn(`[${label}] Tool "${name}" failed, reconnecting: ${firstError instanceof Error ? firstError.message : firstError}`);
          await evict(url);
          try {
            const fresh = await connectMCPAuto(url, label, headers);
            const freshTool = fresh.tools[name];
            if (!freshTool || typeof (freshTool as { execute?: unknown }).execute !== "function") {
              throw firstError;
            }
            // Apply same exclusion logic on retry
            let finalArgs = args;
            if ((name === 'code_directory_tree' || name === 'directory_tree') && args.length > 0) {
              const arg0 = args[0] as Record<string, unknown>;
              if (!arg0.excludePatterns) {
                finalArgs = [{
                  ...arg0,
                  excludePatterns: [".git", ".idea", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", "coverage", ".turbo"]
                }];
              }
            }
            return await withTimeout(
              (freshTool as { execute: (...a: unknown[]) => Promise<unknown> }).execute(...finalArgs),
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

// Function to connect MCPs in parallel and return the tools
async function connectMCPs(
  req: Request,
  figmaMcpUrl: string | undefined,
  figmaAccessToken: string | undefined,
  resolvedCodeProjectPath: string | undefined,
  figmaOAuth: boolean | undefined,
  tunnelSecret: string | undefined,
  mcpCodeUrlHeader: string | null,
  enabledMcps: Record<string, boolean>
): Promise<{ allTools: Record<string, unknown>; mcpErrors: string[] }> {
  const allTools: Record<string, unknown> = {};
  const mcpErrors: string[] = [];

  // Connect Figma MCP if enabled and URL provided
  if (enabledMcps.figma !== false && figmaMcpUrl) {
    try {
      const cookieStore = await cookies();
      // Prefer cookie, fall back to X-Figma-MCP-Tokens header (Figma plugin context)
      const mcpTokensRaw = cookieStore.get(COOKIE_TOKENS)?.value
        ?? req.headers.get("X-Figma-MCP-Tokens")
        ?? undefined;
      let oauthToken = cookieStore.get("figma_access_token")?.value;

      if (figmaOAuth && mcpTokensRaw) {
        try {
          const mcpTokens = JSON.parse(mcpTokensRaw);
          oauthToken = mcpTokens.access_token || mcpTokens.accessToken;
        } catch (e) {
          console.error("[Figma] Failed to parse MCP tokens:", e);
        }
      }

      const useOAuthHttp = !!(figmaOAuth && (oauthToken || mcpTokensRaw));
      const effectiveUrl = (figmaOAuth && figmaMcpUrl === "https://mcp.figma.com/mcp")
        ? figmaMcpUrl
        : (useOAuthHttp ? MCP_FIGMA_SERVER_URL : figmaMcpUrl);

      const figmaHeaders: Record<string, string> = {};
      if (tunnelSecret && !effectiveUrl.includes('figma.com')) {
        figmaHeaders['X-Auth-Token'] = tunnelSecret;
      }
      if (effectiveUrl.includes('trycloudflare.com')) {
        figmaHeaders.Host = 'localhost:3845';
      }

      console.log("[Figma] Connecting to:", effectiveUrl);

      let mcpResult: CachedMCP;
      if (figmaOAuth) {
        const figmaProvider = await createFigmaMcpOAuthProvider(cookieStore);
        // If cookie is missing but header token is present, patch tokens() for plugin context
        const figmaHeaderTokens = !cookieStore.get(COOKIE_TOKENS)?.value
          ? req.headers.get("X-Figma-MCP-Tokens")
          : null;
        const effectiveFigmaProvider = figmaHeaderTokens
          ? {
              ...figmaProvider,
              async tokens() {
                try { return JSON.parse(figmaHeaderTokens); } catch { return undefined; }
              },
            }
          : figmaProvider;
        mcpResult = await getOrConnectWithAuth(effectiveUrl, "Figma", effectiveFigmaProvider);
      } else {
        const token = figmaAccessToken || oauthToken || process.env.FIGMA_ACCESS_TOKEN;
        if (token) {
          figmaHeaders.Authorization = `Bearer ${token}`;
        }
        mcpResult = await getOrConnect(effectiveUrl, "Figma", figmaHeaders);
      }

      const { tools } = mcpResult;
      const prefixedTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [`figma_${name}`, tool])
      );
      Object.assign(allTools, wrapToolsWithRetry(prefixedTools, effectiveUrl, "Figma", figmaHeaders));
      console.log("[Figma] Connected successfully");

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Figma] MCP connection failed:", msg);
      mcpErrors.push(`Figma MCP connection failed: ${msg}`);
    }
  }

  // Connect Figma Console MCP (southleft - online version, requires OAuth) if enabled
  if (enabledMcps.figmaConsole) {
  const figmaConsoleMcpUrl = `${SOUTHLEFT_MCP_URL}/sse`;
  try {
    const cookieStoreForSouthleft = await cookies();
    const southleftTokensRaw = cookieStoreForSouthleft.get(SOUTHLEFT_COOKIE_TOKENS)?.value;

    // Check for Bearer token in Authorization header
    const authHeader = req.headers.get('authorization');
    let bearerToken: string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      bearerToken = authHeader.substring(7);
    }

    if (southleftTokensRaw || bearerToken) {
      console.log("[FigmaConsole] Connecting with OAuth to:", figmaConsoleMcpUrl);
      const southleftProvider = await createSouthleftMcpOAuthProvider(cookieStoreForSouthleft);
      // If bearer token provided, override the provider's tokens method
      if (bearerToken) {
        const originalTokens = southleftProvider.tokens.bind(southleftProvider);
        southleftProvider.tokens = async () => {
          return { access_token: bearerToken, token_type: 'Bearer' };
        };
      }
      const { tools } = await getOrConnectWithAuth(figmaConsoleMcpUrl, "FigmaConsole", southleftProvider);
      const prefixedTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [`figmaconsole_${name}`, tool])
      );
      Object.assign(allTools, wrapToolsWithRetry(prefixedTools, figmaConsoleMcpUrl, "FigmaConsole", {}));
      console.log("[FigmaConsole] Connected successfully");
    } else {
      console.log("[FigmaConsole] No OAuth tokens found — skipping (user needs to sign in via Figma Console button)");
      mcpErrors.push("Figma Console MCP: not authenticated. Click 'Sign in with Figma Console' in the settings panel.");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[FigmaConsole] MCP connection failed:", msg);
    mcpErrors.push(`Figma Console MCP connection failed: ${msg}`);
  }
  } // End of if enabledMcps.figmaConsole

  // Connect GitHub MCP (online OAuth) — HTTP transport (no /sse) if enabled
  if (enabledMcps.github) {
  const githubMcpUrl = GITHUB_MCP_URL;
  try {
    const cookieStoreForGithub = await cookies();
    // Prefer cookie (browser-based), fall back to X-GitHub-MCP-Tokens header
    // (needed in Figma plugin context where popup cookies are not accessible)
    const githubTokensRaw = cookieStoreForGithub.get(GITHUB_COOKIE_TOKENS)?.value
      ?? req.headers.get("X-GitHub-MCP-Tokens")
      ?? undefined;

    if (githubTokensRaw) {
      console.log("[GitHub] Connecting with OAuth to:", githubMcpUrl);
      // Build a provider that uses the tokens — may come from cookie or header
      const githubProvider = await createGithubMcpOAuthProvider(cookieStoreForGithub);
      // If the cookie was missing but we have the header token, patch tokens() method
      const headerTokensRaw = !cookieStoreForGithub.get(GITHUB_COOKIE_TOKENS)?.value
        ? req.headers.get("X-GitHub-MCP-Tokens")
        : null;
      const effectiveProvider = headerTokensRaw
        ? {
            ...githubProvider,
            async tokens() {
              try { return JSON.parse(headerTokensRaw); } catch { return undefined; }
            },
          }
        : githubProvider;
      const { tools } = await getOrConnectWithAuth(githubMcpUrl, "GitHub", effectiveProvider);
      const prefixedTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [`github_${name}`, tool])
      );
      Object.assign(allTools, wrapToolsWithRetry(prefixedTools, githubMcpUrl, "GitHub", {}));
      console.log("[GitHub] Connected successfully");
    } else {
      console.log("[GitHub] No OAuth tokens found — skipping (user needs to sign in via GitHub button)");
      mcpErrors.push("GitHub MCP: not authenticated. Click 'Sign in with GitHub' in the settings panel.");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[GitHub] MCP connection failed:", msg);
    mcpErrors.push(`GitHub MCP connection failed: ${msg}`);
  }
  } // End of if enabledMcps.github

  // Connect Code MCP if enabled and URL provided
  if (enabledMcps.code !== false && resolvedCodeProjectPath) {
    try {
      const codeHeaders: Record<string, string> = {};
      if (tunnelSecret) {
        codeHeaders['X-Auth-Token'] = tunnelSecret;
      }
      if (mcpCodeUrlHeader) {
        codeHeaders['X-MCP-Code-URL'] = mcpCodeUrlHeader;
      }

      console.log("[Code] Connecting to:", resolvedCodeProjectPath);
      const { tools } = await getOrConnect(resolvedCodeProjectPath, "Code", codeHeaders);
      const prefixedTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [`code_${name}`, tool])
      );
      Object.assign(allTools, wrapToolsWithRetry(prefixedTools, resolvedCodeProjectPath, "Code", codeHeaders));
      console.log("[Code] Connected successfully");

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Code] MCP connection failed:", msg);
      mcpErrors.push(`Code MCP connection failed: ${msg}`);
    }
  }
  console.debug('allTools:');
  console.debug(allTools);
  return { allTools, mcpErrors };
}

export async function POST(req: Request) {
  const { messages, figmaMcpUrl, figmaAccessToken, codeProjectPath, figmaOAuth, model, selectedNode, tunnelSecret, enabledMcps, figmaPluginContext } = await req.json();

  // Get X-MCP-Code-URL header to resolve relative proxy URLs
  console.log("[Header] X-MCP-Code-URL:", req.headers.get("X-MCP-Code-URL"));
  console.log("[Code] codeProjectPath from body:", codeProjectPath);
  const mcpCodeUrlHeader = req.headers.get("X-MCP-Code-URL");
  console.log("[POST] mcpCodeUrlHeader value:", mcpCodeUrlHeader);
  let resolvedCodeProjectPath = codeProjectPath;

  // The X-MCP-Code-URL header is used by the proxy to forward to the correct URL
  // But the connection always happens via codeProjectPath (which is the proxy URL)
  if (resolvedCodeProjectPath) {
    console.log("[Code] Using codeProjectPath from body:", resolvedCodeProjectPath);
  } else if (mcpCodeUrlHeader) {
    // Fallback: if no codeProjectPath, use the header directly
    resolvedCodeProjectPath = mcpCodeUrlHeader;
    console.log("[Code] Using X-MCP-Code-URL header as fallback:", resolvedCodeProjectPath);
  }

  // Prepare messages for the model
  const modelMessages = await convertToModelMessages(messages);

  // Build the dynamic system prompt
  let system = "";
  if (selectedNode && typeof selectedNode === "object") {
    const { nodeUrl, nodes } = selectedNode as { nodeUrl?: string | null; nodes?: unknown[] };
    system += `\n\n### SELECTED FIGMA NODE (from host application — HIGHEST PRIORITY)`;
    if (nodeUrl) {
      system += `\nThe currently selected node URL: ${nodeUrl}`;
    }
    if (nodes && Array.isArray(nodes) && nodes.length > 0) {
      system += `\nSelected node properties (from Figma plugin):\n\`\`\`json\n${JSON.stringify(nodes, null, 2)}\n\`\`\``;
    }
    system += `
CRITICAL RULES:
- The selection is already known from the data above. Do NOT call any Figma MCP tool to get or find the current selection (e.g. get_selection, get_current_selection, etc.).
- When the user refers to "this node", "the selection", "the selected element", "this component", or similar, they mean the node above.
- You may use other Figma MCP tools (e.g. get_node_details, get_styles, etc.) to inspect further properties using the node URL above.
- Always start from this data when the user asks about the current selection.`;
  }


  // Inject Figma plugin context (file currently open in Figma)
  if (figmaPluginContext?.fileName) {
    system += `\n\n### FIGMA PLUGIN CONTEXT (currently open file — HIGH PRIORITY)
  The user is working in the following Figma file:
  - **File Name:** "${figmaPluginContext.fileName}"
  - **File Key:** "${figmaPluginContext.fileKey}"
  - **File URL:** "${figmaPluginContext.fileUrl}"`;
    if (figmaPluginContext.currentPage) {
      system += `\n- **Current Page:** "${figmaPluginContext.currentPage.name}" (id: ${figmaPluginContext.currentPage.id})`;
    }
    if (figmaPluginContext.pages && figmaPluginContext.pages.length > 0) {
      system += `\n- **All Pages:** ${figmaPluginContext.pages.map((p: { id: string; name: string }) => `"${p.name}" (${p.id})`).join(', ')}`;
    }
    if (figmaPluginContext.currentUser) {
      system += `\n- **User:** ${figmaPluginContext.currentUser.name}`;
    }

    if (figmaPluginContext.fileKey) {
      system += `
RULES:
- Use this URL as the default Figma file for any tool call that requires a file key or URL when none is explicitly provided.
- When the user refers to "the current file", "this file", "my file", or similar, they mean this Figma file.
- When the user refers to "the current page" or "this page", they mean the page named above.
- Do NOT ask the user for the Figma file URL if this context is present — you already have it.`;
    } else {
      system += `\n\n
The user is working in a Figma file without key.
Note: This is a Community or unsaved file — no direct file URL is available from the plugin API.
RULES:
- When the user refers to "the current file", "this file", or similar, they mean "${figmaPluginContext.fileName}".
- If you need to access this file via MCP tools, ask the user to paste the Figma file URL from their browser address bar.`;
    }

    console.debug('DYNAMIC SYSTEM PROMPT:');
    console.debug(system);

    // Build the final system prompt
    system = GUARDIAN_SYSTEM_PROMPT + system;
  }

  // Create MCP connection promise (async - non blocking)
  const mcpConnectionPromise = connectMCPs(
    req,
    figmaMcpUrl,
    figmaAccessToken,
    resolvedCodeProjectPath,
    figmaOAuth,
    tunnelSecret,
    mcpCodeUrlHeader,
    enabledMcps || { figma: true, figmaConsole: false, github: false, code: true }
  );

  // Use keepalive stream for async MCP connection with live feedback
  console.log('[Chat] Starting async keepalive stream for MCP connection');
  return new Response(
    createKeepaliveStream(mcpConnectionPromise, modelMessages, system, model || "grok-4-1-fast-non-reasoning"),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    }
  );
}