/**
 * Temporal Worker entry point.
 *
 * Registers workflows and activities, connects to the Temporal server,
 * and starts processing tasks from the guardian-orchestration queue.
 */

import { Worker, NativeConnection } from "@temporalio/worker";
import { callLLM } from "./activities/llm.js";
import { executeFigmaCode } from "./activities/figma-execute.js";
import { checkPresence } from "./activities/presence.js";
import { saveOrchestrationState, persistDurableEvents } from "./activities/persistence.js";
import { fetchFigmaDocs } from "./activities/fetch-docs.js";
import { discoverMCPTools, executeMCPTool, closeStdioPool } from "./activities/mcp.js";

async function run() {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "guardian-orchestration";

  console.log(`[temporal-worker] ⏳ Starting... (${new Date().toISOString()})`);

  const connection = await NativeConnection.connect({ address });
  console.log(`[temporal-worker] ⏳ Connected to Temporal (${address}), building workflow bundle...`);

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

run().catch((err) => {
  console.error("[temporal-worker] Fatal error:", err);
  process.exit(1);
});
// force restart 1774176886
