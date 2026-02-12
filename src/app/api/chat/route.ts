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

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

// Augmenter la limite de taille du body pour l'API chat (20MB)
export const fetchCache = 'force-no-store';

const TOOL_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 10_000;
const MAX_AGE_MS = 2 * 60_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;

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
    // Vérifier que le client peut lister les outils (ping léger)
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

  // Si on a un cache, vérifier qu'il est toujours valide avec un healthcheck
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

  // Si on a un cache, vérifier qu'il est toujours valide avec un healthcheck
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

export async function POST(req: Request) {
  const { messages, figmaMcpUrl, figmaAccessToken, codeProjectPath, figmaOAuth, model, selectedNode, tunnelSecret } = await req.json();

  // Récupérer le header X-MCP-Code-URL pour résoudre les URLs relatives du proxy
  console.log("[Header] X-MCP-Code-URL:", req.headers.get("X-MCP-Code-URL"));
  console.log("[Code] codeProjectPath from body:", codeProjectPath);
  const mcpCodeUrlHeader = req.headers.get("X-MCP-Code-URL");
  let resolvedCodeProjectPath = codeProjectPath;

  // Si le header X-MCP-Code-URL est présent, l'utiliser comme URL de connexion
  // (soit pour résoudre une URL proxy, soit comme URL directe)
  if (mcpCodeUrlHeader) {
    // Détecter si c'est une URL du proxy (relative ou absolue)
    const isProxyUrl = codeProjectPath && (
      codeProjectPath.startsWith("/proxy-local/code/") ||
      codeProjectPath.includes("/proxy-local/code/")
    );
    console.log("[Code] isProxyUrl:", isProxyUrl);

    if (isProxyUrl) {
      // Utiliser directement l'URL du header comme URL de connexion MCP
      // Le header contient déjà l'URL complète vers le serveur MCP
      resolvedCodeProjectPath = mcpCodeUrlHeader;
      console.log("[Code] Resolved proxy URL from header:", resolvedCodeProjectPath);
    } else {
      // Utiliser directement l'URL du header comme URL de connexion MCP
      resolvedCodeProjectPath = mcpCodeUrlHeader;
      console.log("[Code] Using X-MCP-Code-URL header as connection URL:", resolvedCodeProjectPath);
    }
  } else {
    console.log("[Code] Using original codeProjectPath:", resolvedCodeProjectPath);
  }

  let allTools: Record<string, unknown> = {};
  const mcpErrors: string[] = [];

  if (figmaMcpUrl) {
    const cookieStore = await cookies();
    const mcpTokensRaw = cookieStore.get(COOKIE_TOKENS)?.value;
    let oauthToken = cookieStore.get("figma_access_token")?.value;

    if (figmaOAuth && mcpTokensRaw) {
      console.log("[Figma] MCP tokens cookie found, length:", mcpTokensRaw.length);
      try {
        const mcpTokens = JSON.parse(mcpTokensRaw);
        oauthToken = mcpTokens.access_token || mcpTokens.accessToken;
        console.log("[Figma] Extracted token present:", !!oauthToken);
      } catch (e) {
        console.error("[Figma] Failed to parse MCP tokens:", e);
      }
    } else if (figmaOAuth) {
      console.warn("[Figma] OAuth enabled but no MCP tokens cookie found");
    }

    const useOAuthHttp = !!(figmaOAuth && (oauthToken || cookieStore.get(COOKIE_TOKENS)?.value));
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

    console.log("[Figma] Connection details:", { effectiveUrl, isOAuth: !!figmaOAuth });

    try {
      let mcpResult: CachedMCP;
      if (figmaOAuth) {
        const provider = createFigmaMcpOAuthProvider(cookieStore);
        const currentTokens = await provider.tokens();
        const token = currentTokens?.access_token;
        console.log("[Figma] OAuth mode, token present:", !!token, "length:", token?.length);

        // Use authProvider for MCP connection (handles OAuth automatically)
        mcpResult = await getOrConnectWithAuth(effectiveUrl, "Figma", provider);
      } else {
        const token = figmaAccessToken || oauthToken || process.env.FIGMA_ACCESS_TOKEN;
        if (token) {
          figmaHeaders.Authorization = `Bearer ${token}`;
          console.log("[Figma] Using manual token, length:", token.length);
        }
        // Use HTTP streamable transport through Next.js proxy (SSE times out via rewrites)
        // For remote non-figma.com URLs, also force HTTP
        mcpResult = await getOrConnect(effectiveUrl, "Figma", figmaHeaders);
      }
      
      const { tools } = mcpResult;
      const prefixedTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [`figma_${name}`, tool])
      );
      allTools = { ...allTools, ...wrapToolsWithRetry(prefixedTools, effectiveUrl, "Figma", figmaHeaders) };

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Figma] MCP connection failed:", msg);
      await evict(effectiveUrl);
      mcpErrors.push(`Figma MCP connection failed (${effectiveUrl}): ${msg}`);
    }
  }

  if (resolvedCodeProjectPath) {
    try {
      const codeHeaders: Record<string, string> = {};
      if (tunnelSecret) {
        codeHeaders['X-Auth-Token'] = tunnelSecret;
      }
      // Passer X-MCP-Code-URL si le header est présent (pour le proxy ou pour info)
      if (mcpCodeUrlHeader) {
        codeHeaders['X-MCP-Code-URL'] = mcpCodeUrlHeader;
      }
      console.log("[Code] Connecting with headers:", codeHeaders);
      const { tools } = await getOrConnect(resolvedCodeProjectPath, "Code", codeHeaders);
      const prefixedTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [`code_${name}`, tool])
      );
      allTools = { ...allTools, ...wrapToolsWithRetry(prefixedTools, resolvedCodeProjectPath, "Code", codeHeaders) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Code] MCP connection failed:", msg);
      await evict(resolvedCodeProjectPath);
      mcpErrors.push(`Code MCP (filesystem) connection failed for "${resolvedCodeProjectPath}": ${msg}`);
    }
  }

  let system = GUARDIAN_SYSTEM_PROMPT;
  if (selectedNode) {
    system += `\n\n### SELECTED FIGMA NODE (from host application — HIGHEST PRIORITY)
The currently selected node in Figma has the following URL: ${selectedNode}
CRITICAL RULES:
- This URL is ALREADY the selected node. Do NOT call any Figma MCP tool to get or find the current selection (e.g. get_selection, get_current_selection, etc.). The selection is already known.
- When the user refers to "this node", "the selection", "the selected element", "this component", or similar, they mean this URL.
- You may use other Figma MCP tools (e.g. get_node_details, get_styles, etc.) to inspect the properties of this node using the URL above.
- Always start from this URL when the user asks about the current selection.`;
  }
  if (mcpErrors.length > 0) {
    system += `\n\n⚠️ MCP CONNECTION ERRORS:\n${mcpErrors.join("\n")}\nTell the user about these connection errors so they can fix them.\n\nIMPORTANT: Do NOT use [MCP_ERROR_BLOCK] tags in your response. These tags are reserved for system error messages only.`;
  }
  if (Object.keys(allTools).length > 0) {
    const figmaTools = Object.keys(allTools).filter(t => t.startsWith('figma_') || t.includes('figma'));
    const codeTools = Object.keys(allTools).filter(t => !figmaTools.includes(t));
    system += `\n\nAvailable MCP tools:
  - Figma MCP: ${figmaTools.join(", ")}
  - Code MCP: ${codeTools.join(", ")}`;
  }

  // Si un MCP explicitement demandé par l'utilisateur est en erreur,
  // on ajoute un message d'erreur visible mais on continue vers Grok pour qu'il puisse aider à résoudre
  const codeError = mcpErrors.find(e => e.includes("Code MCP"));
  const figmaError = mcpErrors.find(e => e.includes("Figma MCP"));

  const criticalMcpErrors: string[] = [];
  if (resolvedCodeProjectPath && codeError) {
    criticalMcpErrors.push(`Code MCP connection failed. ${codeError}`);
  }
  if ((figmaMcpUrl || figmaOAuth) && figmaError) {
    criticalMcpErrors.push(`Figma MCP connection failed. ${figmaError}`);
  }

  // Si on a des erreurs MCP critiques et aucun outil disponible,
  // on ajoute un message d'erreur visible mais on continue vers Grok pour qu'il puisse aider à résoudre
  if (mcpErrors.length > 0 && Object.keys(allTools).length === 0) {
    console.error("[Chat] Critical MCP errors, no tools available:", mcpErrors);
    // Ajouter seulement les erreurs qui ne sont pas déjà dans criticalMcpErrors
    for (const err of mcpErrors) {
      const isDuplicate = criticalMcpErrors.some(critical => critical.includes(err) || err.includes(critical));
      if (!isDuplicate) {
        criticalMcpErrors.push(err);
      }
    }
  }

  // Si on a des erreurs MCP (critiques ou partielles),
  // ajouter un message système initial pour informer l'utilisateur
  const modelMessages = await convertToModelMessages(messages);

  if (mcpErrors.length > 0 && Object.keys(allTools).length > 0) {
    const errorMessage = `⚠️ **MCP Connection Warning**

The following MCP servers failed to connect:
${mcpErrors.map(e => `- ${e}`).join("\n")}

Some features may be limited. Please check your MCP settings.`;

    // Ajouter un message user initial avec l'erreur pour forcer le modèle à y répondre
    modelMessages.unshift({
      role: "user",
      content: `[SYSTEM NOTICE]: ${errorMessage}\n\nPlease acknowledge this connection error in your response before addressing the user's request.`,
    } as typeof modelMessages[0]);
  }

  // Utiliser le Responses API (Agent Tools API) pour avoir accès aux outils natifs xAI comme web_search
  // Le Responses API ne supporte pas les client-side tools, donc on garde les MCP tools côté serveur uniquement
  const result = streamText({
    model: xai.responses(model === "grok-4-1-fast-non-reasoning" ? "grok-4-1-fast-non-reasoning" : "grok-4-1-fast-reasoning"),
    system,
    messages: modelMessages,
    tools: {
      // Outils MCP (Figma/Code) - exécutés côté serveur
      ...allTools,
      // Outil de recherche web natif xAI
      web_search: xai.tools.webSearch(),
    } as Parameters<typeof streamText>[0]["tools"],
    stopWhen: stepCountIs(10),
    onStepFinish: (step) => {
      // Log tool calls pour debug
      if (step.toolCalls.length > 0) {
        console.log("[Chat] Tool calls:", step.toolCalls.map(t => t));
      }
      if (step.toolResults.length > 0) {
        console.log("[Chat] Tool results:", step.toolResults.map(t => t));
      }
    },
  });

  // Si on a des erreurs critiques MCP, on veut les afficher immédiatement dans le chat
  // tout en continuant le flux vers Grok
  if (criticalMcpErrors.length > 0) {
    const errorText = criticalMcpErrors.join("\n");
    const errorId = `error-${Date.now()}`;

    // Créer un stream SSE avec le format correct du protocole AI SDK
    const errorStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // Message start
        controller.enqueue(encoder.encode(`data: {"type":"start"}\n\n`));

        // Text start
        controller.enqueue(encoder.encode(`data: {"type":"text-start","id":"${errorId}"}\n\n`));

        // Text delta avec le message d'erreur (format spécial pour détection côté client)
        const errorMessage = `[MCP_ERROR_BLOCK]\n${errorText}\n[/MCP_ERROR_BLOCK]`;
        controller.enqueue(encoder.encode(`data: {"type":"text-delta","id":"${errorId}","delta":${JSON.stringify(errorMessage)}}\n\n`));

        // Text end
        controller.enqueue(encoder.encode(`data: {"type":"text-end","id":"${errorId}"}\n\n`));

        // Finish step et finish message
        controller.enqueue(encoder.encode(`data: {"type":"finish-step"}\n\n`));
        controller.enqueue(encoder.encode(`data: {"type":"finish","finishReason":"stop"}\n\n`));
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));

        controller.close();
      },
    });

    // Combiner le stream d'erreur avec le stream de Grok
    const grokStream = result.toUIMessageStreamResponse().body;
    if (!grokStream) {
      return new Response(errorStream, {
        headers: { "Content-Type": "text/plain" },
      });
    }

    const combinedStream = new ReadableStream({
      async start(controller) {
        const reader = errorStream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
        }

        const grokReader = grokStream.getReader();
        try {
          while (true) {
            const { done, value } = await grokReader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } finally {
          grokReader.releaseLock();
        }

        controller.close();
      },
    });

    return new Response(combinedStream, {
      headers: { "Content-Type": "text/plain" },
    });
  }

  return result.toUIMessageStreamResponse();
}