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
import { executeFigmaCode } from "./activities/figma-execute.js";
import { checkPresence } from "./activities/presence.js";
import { saveOrchestrationState, persistDurableEvents } from "./activities/persistence.js";
import { fetchFigmaDocs } from "./activities/fetch-docs.js";
import { discoverMCPTools, executeMCPTool, pairFCCloudRelay, closeStdioPool } from "./activities/mcp.js";

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

  const connection = await NativeConnection.connect(connOpts);
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
      executeFigmaCode,
      checkPresence,
      saveOrchestrationState,
      persistDurableEvents,
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
