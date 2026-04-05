/**
 * Temporal Worker entry point.
 *
 * Registers workflows and activities, connects to the Temporal server,
 * and starts processing tasks from the guardian-orchestration queue.
 *
 * Supports three connection modes (auto-detected from env vars):
 *   1. Local dev server — plain gRPC, no TLS (default)
 *   2. Temporal Cloud API key — TLS + TEMPORAL_API_KEY
 *   3. Temporal Cloud mTLS — TLS + base64-encoded client certificate pair
 */

import { Worker, NativeConnection, type NativeConnectionOptions } from "@temporalio/worker";
import { callLLM } from "./activities/llm.js";
import { callLLMStreaming } from "./activities/llm-streaming.js";
import { executeFigmaCode } from "./activities/figma-execute.js";
import { checkPresence } from "./activities/presence.js";
import { saveOrchestrationState, persistDurableEvents } from "./activities/persistence.js";
import { persistChatMessage, loadChatHistory } from "./activities/chat-persistence.js";
import { broadcastChatEvent } from "./activities/chat-broadcast.js";
import { fetchFigmaDocs } from "./activities/fetch-docs.js";
import { discoverMCPTools, executeMCPTool, pairFCCloudRelay, closeStdioPool } from "./activities/mcp.js";

/**
 * Detects transient transport errors that warrant a retry during startup.
 *
 * Typical cases:
 *   - Local dev: worker launched before the Temporal dev server has finished
 *     binding :7233 (race condition inside `concurrently`).
 *   - Production: rolling restart of the Temporal cluster, transient network.
 */
function isRetryableConnectError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|Connection refused|tcp connect error|TransportError|UNAVAILABLE|failed to connect/i.test(
    message,
  );
}

/**
 * Connects to the Temporal server with a bounded retry window.
 *
 * - Development (NODE_ENV !== "production"): 10 seconds — enough to cover the
 *   `temporal server start-dev` bind time in the concurrently race condition.
 * - Production: 30 seconds — covers rolling restarts and transient network blips.
 *
 * Non-transport errors (auth, TLS, malformed address) are thrown immediately
 * without retrying, since they are not going to self-heal by waiting.
 */
async function connectWithRetry(
  connOpts: NativeConnectionOptions,
  windowMs: number,
): Promise<NativeConnection> {
  const deadline = Date.now() + windowMs;
  let attempt = 0;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    attempt++;
    try {
      return await NativeConnection.connect(connOpts);
    } catch (err) {
      lastErr = err;
      if (!isRetryableConnectError(err)) throw err;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const delay = Math.min(1000, remainingMs);
      const firstLine = (err instanceof Error ? err.message : String(err)).split("\n")[0];
      console.log(
        `[temporal-worker] ⏳ Connect attempt ${attempt} failed (${firstLine}) — retrying in ${delay}ms (${Math.ceil(remainingMs / 1000)}s left)`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastErr ?? new Error("Failed to connect to Temporal server within retry window");
}

async function run() {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "guardian-orchestration";
  const apiKey = process.env.TEMPORAL_API_KEY;
  const certB64 = process.env.TEMPORAL_CLIENT_CERT_BASE64;
  const keyB64 = process.env.TEMPORAL_CLIENT_KEY_BASE64;

  console.log(`[temporal-worker] ⏳ Starting... (${new Date().toISOString()}) address=${address} namespace=${namespace} apiKey=${apiKey ? "set" : "unset"}`);

  const connOpts: NativeConnectionOptions = { address };

  if (apiKey) {
    connOpts.tls = true;
    connOpts.apiKey = apiKey;
  } else if (certB64 && keyB64) {
    connOpts.tls = {
      clientCertPair: {
        crt: Buffer.from(certB64, "base64"),
        key: Buffer.from(keyB64, "base64"),
      },
    };
  }

  const retryWindowMs = process.env.NODE_ENV === "production" ? 30_000 : 10_000;
  const connection = await connectWithRetry(connOpts, retryWindowMs);
  const mode = apiKey ? "Cloud (API key)" : certB64 ? "Cloud (mTLS)" : "local";
  console.log(`[temporal-worker] ⏳ Connected to Temporal (${address}, ${mode}), building workflow bundle...`);

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: new URL("./workflows", import.meta.url).pathname,
    // In dev, disable webpack cache so workspace dependency changes
    // (@guardian/orchestrations) are always picked up on restart.
    // In prod, caching is fine since the bundle is built once at deploy time.
    ...(process.env.NODE_ENV !== "production" && {
      bundlerOptions: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        webpackConfigHook: (config: any) => {
          config.cache = false;
          return config;
        },
      },
    }),
    activities: {
      callLLM,
      callLLMStreaming,
      executeFigmaCode,
      checkPresence,
      saveOrchestrationState,
      persistDurableEvents,
      persistChatMessage,
      loadChatHistory,
      broadcastChatEvent,
      fetchFigmaDocs,
      discoverMCPTools,
      executeMCPTool,
      pairFCCloudRelay,
      closeStdioPool,
    },
  });

  console.log(`[temporal-worker] ✅ Ready — listening on task queue: ${taskQueue}`);

  // Run the worker until shutdown signal
  await worker.run();

  // Cleanup on shutdown (enables clean --watch restarts)
  console.log(`[temporal-worker] 🛑 Stopping — cleaning up MCP pool...`);
  await closeStdioPool({}).catch(() => {});
  await connection.close();
  console.log(`[temporal-worker] 🛑 Stopped`);

  // Force exit — stdio subprocess pipes can keep the process alive
  setTimeout(() => process.exit(0), 1000).unref();
}

run().catch(async (err) => {
  console.error("[temporal-worker] Fatal error:", err);
  await closeStdioPool({}).catch(() => {});
  process.exit(1);
});
