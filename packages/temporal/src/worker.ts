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
import { saveOrchestrationState } from "./activities/persistence.js";

async function run() {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "guardian-orchestration";

  console.log(`[temporal-worker] Connecting to ${address} (namespace: ${namespace})`);

  const connection = await NativeConnection.connect({ address });

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
    },
  });

  console.log(`[temporal-worker] Listening on task queue: ${taskQueue}`);

  // Run the worker until shutdown signal
  await worker.run();
}

run().catch((err) => {
  console.error("[temporal-worker] Fatal error:", err);
  process.exit(1);
});
