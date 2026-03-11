import { xai } from "@ai-sdk/xai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGateway } from "@ai-sdk/gateway";
import { streamText, stepCountIs, convertToModelMessages, type LanguageModel, wrapLanguageModel, extractReasoningMiddleware } from "ai";
import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { FREE_TIER_MODEL } from "@/lib/providers";
import { getModelPricing } from "@/lib/model-pricing";
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
import { figmaPluginExecuteTool } from "@/tools/figma-plugin-execute";
import { signalTaskCompleteTool } from "@/tools/signal-task-complete";
import { orchestratorFigmaGuardTool } from "@/tools/orchestrator-figma-guard";

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
const FREE_TIER_DAILY_TOKEN_LIMIT = 500_000; // Rolling 24h token limit for free tier

const encoder = new TextEncoder();

type ResolvedModel = {
  model: LanguageModel;
  isFreeTier: boolean;
  supportsWebSearch: boolean;
  modelId: string;
};

/**
 * Resolve the AI model to use for a given request.
 *
 * Priority (BYOK system):
 *  1. User has a `gateway` key → Vercel AI Gateway with their key + requested model
 *  2. User has a direct key for the requested provider → use that SDK
 *  3. No keys → platform free tier (XAI or AI_GATEWAY_API_KEY + FREE_TIER_MODEL)
 *
 * requestedModel format: "provider/model-id" (e.g. "openai/gpt-4o")
 * Legacy format: no slash → treated as XAI grok model.
 */
async function resolveModel(
  userId: string | null | undefined,
  requestedModel: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
): Promise<ResolvedModel> {
  const modelStr = requestedModel ?? "";
  const slashIdx = modelStr.indexOf("/");
  const requestedProvider = slashIdx > -1 ? modelStr.slice(0, slashIdx) : null;
  const requestedModelId = slashIdx > -1 ? modelStr.slice(slashIdx + 1) : modelStr;

  // ── Free tier (not logged in or legacy XAI model string) ──────────────────
  if (!userId || !requestedProvider) {
    return resolveFreeTier(userId);
  }

  // ── Check user's Vercel AI Gateway key first ──────────────────────────────
  const { data: gatewaySecret } = await supabase.rpc("get_api_key", { p_provider: "gateway" });
  if (gatewaySecret) {
    const gw = createGateway({ apiKey: gatewaySecret });
    return { model: gw(modelStr), isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
  }

  // ── Check user's direct provider key ──────────────────────────────────────
  const { data: providerSecret } = await supabase.rpc("get_api_key", { p_provider: requestedProvider });
  if (providerSecret) {
    const model = buildDirectProviderModel(requestedProvider, requestedModelId, providerSecret);
    if (model) return { model, isFreeTier: false, supportsWebSearch: false, modelId: modelStr };
  }

  // ── No matching key → fall back to free tier ──────────────────────────────
  return resolveFreeTier(userId);
}

function buildDirectProviderModel(provider: string, modelId: string, apiKey: string): LanguageModel | null {
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case "xai":
      return xai(modelId);
    default:
      return null;
  }
}

async function resolveFreeTier(userId: string | null | undefined): Promise<ResolvedModel> {
  // Token usage is now tracked in onFinish (after streaming completes) via increment_usage(user_id, tokens)

  const platformGatewayKey = process.env.AI_GATEWAY_API_KEY;
  if (platformGatewayKey) {
    const gw = createGateway({ apiKey: platformGatewayKey });
    return { model: gw(FREE_TIER_MODEL), isFreeTier: true, supportsWebSearch: false, modelId: FREE_TIER_MODEL };
  }

  // Fallback: platform XAI key
  return {
    model: xai.responses("grok-4-1-fast-non-reasoning"),
    isFreeTier: true,
    supportsWebSearch: true,
    modelId: "xai/grok-4-1-fast-non-reasoning",
  };
}

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
  resolvedModel: ResolvedModel,
  freeTierUserId?: string | null,
  freeTierModelId?: string | null,
  isLocalPlugin?: boolean,
  supportsReasoning?: boolean,
  agentRole?: string,
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

          // When the webapp runs inside a Figma plugin, add a client-side tool
          // that bypasses MCP + Supabase RT and executes code directly via postMessage.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const finalTools: Record<string, any> = { ...mcpResult.allTools };
          if (isLocalPlugin) {
            // Remove the MCP figma_execute tool (goes through Supabase RT — slow/timeout-prone)
            delete finalTools["guardian_guardian_figma_execute"];
            // Add a client-side tool (no execute → handled by useChat onToolCall)
            finalTools["figma_plugin_execute"] = figmaPluginExecuteTool;
            console.log("[Chat] Local plugin detected — added figma_plugin_execute (client-side), removed guardian_guardian_figma_execute");
          }

          // Collaborator mode: add signal_task_complete tool (client-side)
          // The agent calls this tool to signal that its task is done.
          // Intercepted by onToolCall in page.tsx → sends sendAgentResponse("completed").
          if (agentRole === 'collaborator') {
            finalTools["signal_task_complete"] = signalTaskCompleteTool;
            console.log("[Chat] Collaborator mode — added signal_task_complete (client-side)");
          }

          // Orchestrator mode: replace Figma execution tool with a guarded version
          // that blocks execution and returns guidance. This prevents the double-execution
          // bug where both the orchestrator AND the collaborator create the same shape.
          // Tool descriptions alone are not reliable — LLMs ignore them.
          if (agentRole === 'orchestrator') {
            if (finalTools["guardian_guardian_figma_execute"]) {
              finalTools["guardian_guardian_figma_execute"] = orchestratorFigmaGuardTool;
              console.log("[Chat] Orchestrator mode — replaced guardian_guardian_figma_execute with guarded version (blocks execution)");
            }
          }

          // Wrap model with extractReasoningMiddleware for non-reasoning models
          // so <thinking> tags in text become native reasoning events
          const finalModel = supportsReasoning
            ? resolvedModel.model
            : wrapLanguageModel({
                model: resolvedModel.model as Parameters<typeof wrapLanguageModel>[0]["model"],
                middleware: extractReasoningMiddleware({ tagName: 'thinking' }),
              });

          // Now start streamText with MCP tools + optional client-side tool
         const result = streamText({
           model: finalModel,
           system,
           messages: modelMessages,
           tools: {
             ...finalTools,
             ...(resolvedModel.supportsWebSearch ? { web_search: xai.tools.webSearch() } : {}),
           } as Parameters<typeof streamText>[0]["tools"],
            stopWhen: stepCountIs(MAX_STEPS),
           onStepFinish: (step) => {
             console.log(`[Chat] Step finished: reason=${step.finishReason}, toolCalls=${step.toolCalls.length}, usage=${JSON.stringify(step.usage)}`);
             if (step.finishReason === "length") {
               console.warn("[Chat] ⚠️ Step hit max output tokens (finishReason=length) — AI response was TRUNCATED. Tool calls in this step may have incomplete arguments.");
             }
             if (step.toolCalls.length > 0) {
               console.log("[Chat] Tool calls:", step.toolCalls.map(t => ({ name: t.toolName, inputLength: JSON.stringify(t.input).length })));
             }
             if (step.toolResults.length > 0) {
               console.log("[Chat] Tool results:", step.toolResults.map(r => ({ toolName: r.toolName, result: JSON.stringify((r as Record<string, unknown>).result)?.substring(0, 300) })));
             }
           },
           onFinish: (result) => {
              console.log("[Chat] Keepalive stream finished with reason:", result.finishReason, "steps:", result.steps.length);
              if (result.finishReason === 'stop' && result.steps.length >= MAX_STEPS) {
                console.warn(`[Chat] Keepalive stream stopped due to max steps (${MAX_STEPS}) - response may be truncated`);
              }
              // Track detailed token + cost usage for free-tier users (rolling 24h window)
              if (freeTierUserId && result.totalUsage) {
                const inputTokens = result.totalUsage.inputTokens ?? 0;
                const outputTokens = result.totalUsage.outputTokens ?? 0;
                const modelId = freeTierModelId ?? "unknown";
                console.log(`[FreeTier] Tracking tokens (input: ${inputTokens}, output: ${outputTokens}, model: ${modelId}) for user: ${freeTierUserId}`);
                void (async () => {
                  try {
                    const pricing = await getModelPricing(modelId);
                    const costInput = inputTokens * pricing.inputPerToken;
                    const costOutput = outputTokens * pricing.outputPerToken;
                    console.log(`[FreeTier] Cost: input=$${costInput.toFixed(6)}, output=$${costOutput.toFixed(6)}, total=$${(costInput + costOutput).toFixed(6)}`);
                    const serviceClient = createServiceClient();
                    const { data } = await serviceClient.rpc("increment_usage", {
                      p_user_id: freeTierUserId,
                      p_input_tokens: inputTokens,
                      p_output_tokens: outputTokens,
                      p_model: modelId,
                      p_cost_input: costInput,
                      p_cost_output: costOutput,
                    });
                    console.log(`[FreeTier] Usage updated — rolling 24h total: ${data} tokens`);
                  } catch (e) {
                    console.error("[FreeTier] Failed to track token usage:", e);
                  }
                })();
              }
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
  tokenFingerprint?: string;
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

/**
 * Like getOrConnectWithAuth but skips health checks and age eviction entirely.
 * Use for stateless OAuth MCPs (e.g. Southleft figma-console /mcp) where the
 * Bearer token is used directly for API calls.
 * Invalidates the cache when the OAuth token changes (e.g. user re-authenticated).
 */
async function getOrConnectWithAuthSession(url: string, label: string, authProvider: import("@ai-sdk/mcp").OAuthClientProvider, headers?: Record<string, string>): Promise<CachedMCP> {
  const currentToken = (await authProvider.tokens?.())?.access_token;
  const currentFingerprint = currentToken ? currentToken.substring(0, 20) : undefined;

  const cached = mcpClients.get(url);

  if (cached) {
    // If the token changed (user re-authenticated), evict and reconnect
    if (cached.tokenFingerprint && currentFingerprint && cached.tokenFingerprint !== currentFingerprint) {
      console.log(`[${label}] Token changed (was ${cached.tokenFingerprint}… → now ${currentFingerprint}…) — evicting cached session.`);
      await evict(url);
    } else {
      console.log(`[${label}] Reusing cached session (age ${Math.round((Date.now() - cached.connectedAt) / 1000)}s, token ${currentFingerprint ?? "unknown"}…).`);
      return cached;
    }
  }

  console.log(`[${label}] Creating new authenticated connection.`);
  const entry = await connectMCPWithAuth(url, label, authProvider, headers);
  entry.tokenFingerprint = currentFingerprint;
  return entry;
}

/**
 * Wraps tools with timeout only — no eviction, no reconnect on failure.
 * Use for session-based OAuth MCPs (e.g. Southleft) where eviction would destroy
 * the authenticated session and reconnect without auth.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapToolsWithTimeout(tools: Record<string, any>, label: string): Record<string, any> {
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = {
      ...tool,
      execute: async (...args: unknown[]) => {
        const toolResult = await withTimeout(
          (tool as { execute: (...a: unknown[]) => Promise<unknown> }).execute(...args),
          TOOL_TIMEOUT_MS,
          `Tool "${name}"`,
        );
        console.log(`[${label}] Tool "${name}" raw result:`, JSON.stringify(toolResult)?.substring(0, 300));
        return toolResult;
      },
    };
  }
  return wrapped;
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
          const firstErrorMsg = firstError instanceof Error ? firstError.message : String(firstError);
          console.warn(`[${label}] Tool "${name}" failed — EVICTING SESSION at ${url}. Error: ${firstErrorMsg}`);
          await evict(url);
          try {
            console.warn(`[${label}] Reconnecting via connectMCPAuto (NO OAUTH / NO AUTH) for: ${url}`);
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
  enabledMcps: Record<string, boolean>,
  supabaseAccessToken?: string,
  targetClientId?: string
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
        const token = figmaAccessToken || oauthToken;
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
  const figmaConsoleMcpUrl = process.env.SOUTHLEFT_MCP_RESOURCE || `${SOUTHLEFT_MCP_URL}/mcp`;
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
      // Only use the Authorization header Bearer token as fallback when the Southleft OAuth cookie is absent.
      // The cookie token (from the dedicated Southleft OAuth flow) takes priority.
      if (bearerToken && !southleftTokensRaw) {
        southleftProvider.tokens = async () => {
          return { access_token: bearerToken, token_type: 'Bearer' };
        };
      }
      // Diagnostic: log what token will be used for this SSE connection
      const providerTokens = await southleftProvider.tokens?.();
      const tokenSource = southleftTokensRaw ? "southleft_mcp_tokens cookie" : (bearerToken ? "Authorization header (fallback)" : "none");
      console.log("[FigmaConsole] Token present:", !!providerTokens, "| prefix:", providerTokens?.access_token?.substring(0, 15) ?? "none", "| source:", tokenSource);
      const { tools } = await getOrConnectWithAuthSession(figmaConsoleMcpUrl, "FigmaConsole", southleftProvider);
      const prefixedTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [`figmaconsole_${name}`, tool])
      );
      // Use timeout-only wrapper (no retry/eviction) to preserve the OAuth session
      Object.assign(allTools, wrapToolsWithTimeout(prefixedTools, "FigmaConsole"));
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
  // Connect Guardian MCP if enabled and URL provided
  const guardianMcpUrl = process.env.GUARDIAN_MCP_URL;
  if (enabledMcps.guardian !== false && guardianMcpUrl) {
    try {
      console.log("[Guardian] Connecting to:", guardianMcpUrl);
      const guardianHeaders: Record<string, string> = {};
      if (supabaseAccessToken) {
        guardianHeaders["Authorization"] = `Bearer ${supabaseAccessToken}`;
      }
      const { tools } = await getOrConnect(guardianMcpUrl, "Guardian", guardianHeaders);
      const prefixedTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [`guardian_${name}`, tool])
      );
      const wrappedGuardian = wrapToolsWithRetry(prefixedTools, guardianMcpUrl, "Guardian");
      // Intercept guardian_figma_execute to inject targetClientId automatically
      // Tool is "guardian_figma_execute" in MCP, prefixed with "guardian_" → "guardian_guardian_figma_execute"
      const execToolKey = "guardian_guardian_figma_execute";
      if (targetClientId && wrappedGuardian[execToolKey]) {
        const origTool = wrappedGuardian[execToolKey] as { execute: (...args: unknown[]) => Promise<unknown>; [k: string]: unknown };
        const origExecute = origTool.execute;
        wrappedGuardian[execToolKey] = {
          ...origTool,
          execute: async (...args: unknown[]) => {
            if (args.length > 0) {
              const existingArgs = args[0] as Record<string, unknown>;
              // Only inject targetClientId as fallback — if the LLM explicitly
              // specified one (e.g. targeting a specific plugin by shortId), respect it.
              if (!existingArgs.targetClientId) {
                args[0] = { ...existingArgs, targetClientId };
              }
            }
            return origExecute(...args);
          },
        };
      }
      Object.assign(allTools, wrappedGuardian);
      console.log("[Guardian] Connected successfully");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Guardian] MCP connection failed:", msg);
      mcpErrors.push(`Guardian MCP connection failed: ${msg}`);
    }
  }

  //console.debug('allTools:');
  //console.debug(allTools);
  return { allTools, mcpErrors };
}

export async function POST(req: Request) {
  const {
    messages, figmaMcpUrl, figmaAccessToken, codeProjectPath, figmaOAuth,
    model, selectedNode, tunnelSecret, enabledMcps, figmaPluginContext,
    isLocalPlugin,  // true when webapp runs inside a Figma plugin, false when targeting remote
    targetClientId,
    orchestrationId,
    agentRole,        // 'idle' | 'orchestrator' | 'collaborator'
    orchestrationContext,  // { task?, collaborators?, orchestratorShortId? }
    connectedAgents,  // other agents available for collaboration (all roles)
    timerRemainingMs, // ms remaining in orchestration timer (null if not in orchestration)
    supportsReasoning, // true if model natively supports extended thinking (from Gateway catalog tags)
  } = await req.json();

  // Resolve the AI model (BYOK or free tier)
  const supabase = await createSupabaseUserClient();
  const { data: { user } } = await supabase.auth.getUser();
  // Get the user's access token to forward to authenticated MCP servers
  const { data: { session: supabaseSession } } = await supabase.auth.getSession();
  const resolvedModel = await resolveModel(user?.id, model, supabase);

  // Enforce rolling 24h token limit for free-tier users
  if (resolvedModel.isFreeTier && user?.id) {
    const serviceClient = createServiceClient();
    const { data: currentUsage, error: usageError } = await serviceClient.rpc("get_usage_for_user", { p_user_id: user.id });
    if (!usageError && typeof currentUsage === "number" && currentUsage >= FREE_TIER_DAILY_TOKEN_LIMIT) {
      return new Response(
        JSON.stringify({
          error: "daily_limit_exceeded",
          limit: FREE_TIER_DAILY_TOKEN_LIMIT,
          used: currentUsage,
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }
  }

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

  // Deduplicate messages by ID (keep last occurrence — most complete from streaming).
  // During collaborative orchestration, the AI SDK's multi-step tool execution can
  // produce duplicate message IDs in the array, causing "Tool result is missing" errors.
  const seenMsgIds = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dedupedMessages = (messages as any[]).reduceRight((acc: any[], msg: any) => {
    if (msg.id && seenMsgIds.has(msg.id)) return acc;
    if (msg.id) seenMsgIds.add(msg.id);
    acc.unshift(msg);
    return acc;
  }, []);

  // Prepare messages for the model
  const modelMessages = await convertToModelMessages(dedupedMessages);

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

  }

  // Collaborative Agents — agent awareness (idle mode with other agents connected)
  if ((!agentRole || agentRole === 'idle') && connectedAgents && connectedAgents.length > 0) {
    const agentList = connectedAgents.map((a: { shortId: string; label: string; type: string; fileName?: string }) =>
      `${a.shortId} (${a.label}${a.type === 'figma-plugin' ? `, file: "${a.fileName || '?'}"` : ''})`
    ).join(', ');

    system += `\n\n## Connected Agents: ${agentList}

${isLocalPlugin ? 'You run inside a Figma plugin (own file). Other agents have separate files.' : 'You are a webapp. Plugin agents below own their files.'}

**Collaborative Mode (MANDATORY for multi-file tasks):** If the task involves 2+ files, or user says "collab"/"collaborative", you MUST propose orchestration. Output a SHORT plan (agent/file/task table) then on the NEXT line:
\`[ORCHESTRATE:${connectedAgents.map((a: { shortId: string }) => a.shortId).join(',')}]\`
Do NOT write detailed instructions before the marker. Keep it SHORT so the button appears.
Propose orchestration first — do NOT execute on multiple files yourself without asking.
If the user declines or ignores orchestration, you may then execute directly on remote plugins via guardian_guardian_figma_execute with their targetClientId (use the agent shortId).
For single-file tasks, handle directly via ${isLocalPlugin ? 'figma_plugin_execute' : 'guardian_guardian_figma_execute'}.
`;
  }

  // Collaborative Agents — timer context (shared between roles)
  const timerStr = timerRemainingMs != null
    ? `\nTime remaining: ${Math.ceil(timerRemainingMs / 60000)}min ${Math.ceil((timerRemainingMs % 60000) / 1000)}s. ${timerRemainingMs < 120000 ? 'HURRY — wrap up quickly!' : ''}`
    : '';

  // Collaborative Agents — orchestration context
  if (agentRole === 'orchestrator' && orchestrationId) {
    const collabList = orchestrationContext?.collaborators?.map((c: { shortId: string; label: string }) => `${c.shortId} (${c.label})`).join(', ') || 'None yet';

    system += `\n\n## Orchestrator Mode
Session: ${orchestrationId} | Collaborators: ${collabList}${timerStr}

You coordinate agents. Each collaborator works autonomously with its own AI + Figma access.

**Your workflow:**
1. Wait for agent reports (prefixed \`[Agent report from ...]\`)
2. Evaluate: complete and correct?
3. Yes → mark done: \`[AGENT_DONE:#shortId]\`
4. No → send feedback via @#shortId
5. All done → final summary for the user

**[AGENT_DONE:#shortId]** — MANDATORY to end the session. You can mark multiple agents in one response.

Keep responses SHORT. Agents work autonomously — do not duplicate their work.
`;
  }

  if (agentRole === 'collaborator' && orchestrationId) {
    const orchestratorId = orchestrationContext?.orchestratorShortId || 'unknown';

    // Build peer agent list so collaborators know who else is in the session
    const peerAgents = connectedAgents?.filter((a: { shortId: string }) =>
      a.shortId !== orchestratorId
    ) || [];
    const peerList = peerAgents.length > 0
      ? peerAgents.map((a: { shortId: string; label: string; fileName?: string }) =>
          `${a.shortId} (${a.label}${a.fileName ? `, "${a.fileName}"` : ''})`
        ).join(', ')
      : '';

    system += `\n\n## Collaborator Mode
Orchestrator: ${orchestratorId} | Session: ${orchestrationId}${timerStr}
${peerList ? `Peers: ${peerList}` : ''}

**You work autonomously on your assigned task.** The orchestrator relays messages between you and other agents — their messages arrive as \`[Message from orchestrator]\`. Read those messages carefully and respond to what the orchestrator or peers are saying.

**Figma execution — ITERATIVE approach (critical):**
- Execute ONE small mutation per \`${isLocalPlugin ? 'figma_plugin_execute' : 'guardian_guardian_figma_execute'}\` call (max ~30 lines)
- After each mutation, verify the result before proceeding
- NEVER bundle many operations in one call — long code gets TRUNCATED causing syntax errors
- Split: 1) create node → return ID, 2) set properties using that ID, 3) add children, etc.

**Communication:**
- Messages from the orchestrator relay contain instructions or peer contributions. Engage with them.
- If the task involves discussion/collaboration (not just Figma work), focus on contributing your perspective and responding to what others have said

**When done:** Call the \`signal_task_complete\` tool with a summary of what you accomplished. This is the ONLY way to signal completion — do NOT just write text about being done. Call the tool ONCE after all work is verified.
`;
  }

  // For models without native reasoning, add <thinking> instruction
  // so extractReasoningMiddleware can convert the tags into reasoning events
  if (!supportsReasoning) {
    system += `\n\n## THINKING PROCESS
While you work (searching, reading files, analyzing), emit your reasoning inside <thinking>...</thinking> blocks.
Keep thinking blocks short (1-2 sentences).`;
  }

  // Build the final system prompt
  system = GUARDIAN_SYSTEM_PROMPT + system;

  // Create MCP connection promise (async - non blocking)
  const mcpConnectionPromise = connectMCPs(
    req,
    figmaMcpUrl,
    figmaAccessToken,
    resolvedCodeProjectPath,
    figmaOAuth,
    tunnelSecret,
    mcpCodeUrlHeader,
    enabledMcps || { figma: true, figmaConsole: false, github: false, code: true },
    supabaseSession?.access_token ?? undefined,
    targetClientId
  );

  // Use keepalive stream for async MCP connection with live feedback
  const freeTierUserId = resolvedModel.isFreeTier ? user?.id : null;
  const freeTierModelId = resolvedModel.isFreeTier ? resolvedModel.modelId : null;
  console.log('[Chat] Starting async keepalive stream for MCP connection, isFreeTier:', resolvedModel.isFreeTier);
  return new Response(
    createKeepaliveStream(mcpConnectionPromise, modelMessages, system, resolvedModel, freeTierUserId, freeTierModelId, isLocalPlugin, supportsReasoning, agentRole),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    }
  );
}