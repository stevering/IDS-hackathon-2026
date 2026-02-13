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

export const maxDuration = 300; // 5 minutes pour éviter timeout Cloudflare
export const dynamic = 'force-dynamic';

// Augmenter la limite de taille du body pour l'API chat (20MB)
export const fetchCache = 'force-no-store';

const TOOL_TIMEOUT_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 30_000;
const MAX_AGE_MS = 2 * 60_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;
const STREAM_KEEPALIVE_MS = 5_000; // Envoyer un ping toutes les 5s pendant connexion MCP

// Fonction utilitaire pour encoder un message SSE au format AI SDK
function encodeSSEMessage(type: string, data: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, ...data })}

`;
}

// Créer un stream de keepalive qui envoie des pings pendant la connexion MCP
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

      // Démarrer le stream
      controller.enqueue(encoder.encode(encodeSSEMessage("start", {})));

      // Envoyer un message initial pour indiquer la connexion MCP
      const statusId = `mcp-status-${Date.now()}`;
      controller.enqueue(encoder.encode(encodeSSEMessage("text-start", { id: statusId })));
      controller.enqueue(encoder.encode(encodeSSEMessage("text-delta", {
        id: statusId,
        delta: "[MCP_STATUS:connecting]"
      })));

      // Fonction pour envoyer des pings de keepalive
      const sendKeepalive = () => {
        if (!isMcpReady && controller.desiredSize !== null) {
          controller.enqueue(encoder.encode(encodeSSEMessage("ping", { timestamp: Date.now() })));
        }
      };

      // Démarrer les pings toutes les 5 secondes
      keepaliveInterval = setInterval(sendKeepalive, STREAM_KEEPALIVE_MS);

      try {
        // Attendre la connexion MCP avec un timeout global
        const mcpResult = await Promise.race([
          mcpConnectionPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("MCP connection global timeout")), 120_000)
          )
        ]);

        isMcpReady = true;
        if (keepaliveInterval) clearInterval(keepaliveInterval);

        const { mcpErrors } = mcpResult;

        // Mettre à jour le statut MCP
        // Mettre à jour le statut MCP - faire disparaître le loader
        controller.enqueue(encoder.encode(encodeSSEMessage("text-delta", {
          id: statusId,
          delta: "[MCP_STATUS:connected]"
        })));
        controller.enqueue(encoder.encode(encodeSSEMessage("text-end", { id: statusId })));

        // Si erreurs, les envoyer dans le format attendu par le client
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

        // Maintenant démarrer streamText avec les outils MCP
        const result = streamText({
          model: xai.responses(model === "grok-4-1-fast-non-reasoning" ? "grok-4-1-fast-non-reasoning" : "grok-4-1-fast-reasoning"),
          system,
          messages: modelMessages,
          tools: {
            ...mcpResult.allTools,
            web_search: xai.tools.webSearch(),
          } as Parameters<typeof streamText>[0]["tools"],
          stopWhen: stepCountIs(10),
          onStepFinish: (step) => {
            if (step.toolCalls.length > 0) {
              console.log("[Chat] Tool calls:", step.toolCalls.map(t => t));
            }
            if (step.toolResults.length > 0) {
              console.log("[Chat] Tool results:", step.toolResults.map(t => t));
            }
          },
        });

        // Pipe le stream de streamText vers notre controller
        const aiStream = result.toUIMessageStreamResponse().body;
        if (aiStream) {
          const reader = aiStream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          } finally {
            reader.releaseLock();
          }
        }

      } catch (error) {
        // Erreur de connexion MCP
        if (keepaliveInterval) clearInterval(keepaliveInterval);

        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error("[Chat] MCP connection failed:", errorMsg);

        controller.enqueue(encoder.encode(encodeSSEMessage("text", {
          content: `❌ Erreur de connexion MCP: ${errorMsg}`
        })));
        controller.enqueue(encoder.encode(encodeSSEMessage("finish", { finishReason: "error" })));

      } finally {
        controller.close();
      }
    },

    cancel() {
      // Nettoyage si le client ferme la connexion
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

// Fonction pour connecter les MCPs en parallèle et retourner les outils
async function connectMCPs(
  figmaMcpUrl: string | undefined,
  figmaAccessToken: string | undefined,
  resolvedCodeProjectPath: string | undefined,
  figmaOAuth: boolean | undefined,
  tunnelSecret: string | undefined,
  mcpCodeUrlHeader: string | null
): Promise<{ allTools: Record<string, unknown>; mcpErrors: string[] }> {
  const allTools: Record<string, unknown> = {};
  const mcpErrors: string[] = [];

  // Connecter Figma MCP si URL fournie
  if (figmaMcpUrl) {
    try {
      const cookieStore = await cookies();
      const mcpTokensRaw = cookieStore.get(COOKIE_TOKENS)?.value;
      let oauthToken = cookieStore.get("figma_access_token")?.value;

      if (figmaOAuth && mcpTokensRaw) {
        try {
          const mcpTokens = JSON.parse(mcpTokensRaw);
          oauthToken = mcpTokens.access_token || mcpTokens.accessToken;
        } catch (e) {
          console.error("[Figma] Failed to parse MCP tokens:", e);
        }
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

      console.log("[Figma] Connecting to:", effectiveUrl);

      let mcpResult: CachedMCP;
      if (figmaOAuth) {
        const provider = createFigmaMcpOAuthProvider(cookieStore);
        mcpResult = await getOrConnectWithAuth(effectiveUrl, "Figma", provider);
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

  // Connecter Code MCP si URL fournie
  if (resolvedCodeProjectPath) {
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

  return { allTools, mcpErrors };
}

export async function POST(req: Request) {
  const { messages, figmaMcpUrl, figmaAccessToken, codeProjectPath, figmaOAuth, model, selectedNode, tunnelSecret } = await req.json();

  // Récupérer le header X-MCP-Code-URL pour résoudre les URLs relatives du proxy
  console.log("[Header] X-MCP-Code-URL:", req.headers.get("X-MCP-Code-URL"));
  console.log("[Code] codeProjectPath from body:", codeProjectPath);
  const mcpCodeUrlHeader = req.headers.get("X-MCP-Code-URL");
  let resolvedCodeProjectPath = codeProjectPath;

  // Utiliser l'URL du body directement (comme Figma), le header est optionnel
  // Le header X-MCP-Code-URL peut être utilisé comme fallback si l'URL du body est vide
  if (!resolvedCodeProjectPath && mcpCodeUrlHeader) {
    resolvedCodeProjectPath = mcpCodeUrlHeader;
    console.log("[Code] Using X-MCP-Code-URL header as fallback:", resolvedCodeProjectPath);
  } else {
    console.log("[Code] Using codeProjectPath from body:", resolvedCodeProjectPath);
  }

  // Préparer les messages pour le modèle
  const modelMessages = await convertToModelMessages(messages);

  // Construire le system prompt
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

  // Lancer la connexion MCP en arrière-plan (ne pas await)
  const mcpConnectionPromise = connectMCPs(
    figmaMcpUrl,
    figmaAccessToken,
    resolvedCodeProjectPath,
    figmaOAuth,
    tunnelSecret,
    mcpCodeUrlHeader
  );

  // Créer et retourner le stream avec keepalive
  const stream = createKeepaliveStream(mcpConnectionPromise, modelMessages, system, model || "grok-4-1-fast-reasoning");

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}