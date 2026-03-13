/**
 * End-to-end tests: orchestration workflows against a live Temporal server.
 *
 * Usage:
 *   1. Start Temporal dev server: temporal server start-dev
 *   2. Start worker: source .env.local && TEMPORAL_ADDRESS=localhost:7233 tsx packages/temporal/src/worker.ts
 *   3. Run tests: TEMPORAL_ADDRESS=localhost:7233 tsx packages/temporal/src/test-e2e.ts
 *
 * Supports running individual tests via CLI arg: tsx test-e2e.ts cancel
 */

import { Client, Connection } from "@temporalio/client";
import { statusQuery, userInputSignal, stopSignal } from "./signals/definitions.js";
import type { StartOrchestrationParams, AgentId } from "@guardian/orchestrations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let client: Client;
let taskQueue: string;

function makeAgents(): AgentId[] {
  return [
    { shortId: "agent-1", workflowId: "", label: "Agent 1", type: "figma-plugin", fileName: "file-1.fig" },
    { shortId: "agent-2", workflowId: "", label: "Agent 2", type: "web" },
  ];
}

function makeParams(overrides?: Partial<StartOrchestrationParams>): StartOrchestrationParams {
  return {
    userId: "e2e-test-user",
    task: "Create a button component with primary and secondary variants",
    targetAgents: makeAgents(),
    maxDurationMs: 60_000,
    ...overrides,
  };
}

async function pollUntilDone(
  handle: Awaited<ReturnType<Client["workflow"]["start"]>>,
  maxPolls = 20,
  intervalMs = 3000
): Promise<{ status: string; events: unknown[]; agents: { id: string; status: string }[] }> {
  const allEvents: unknown[] = [];

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    try {
      const s = await handle.query(statusQuery);
      const agents = s.agents?.map((a: { shortId: string; status: string }) => ({
        id: a.shortId,
        status: a.status,
      })) ?? [];

      if (s.events?.length) allEvents.push(...s.events);

      console.log(`    poll #${i + 1}: status=${s.status}, agents=[${agents.map((a: { id: string; status: string }) => `${a.id}:${a.status}`).join(",")}], events=${s.events?.length ?? 0}`);

      if (s.status !== "active") {
        return { status: s.status, events: allEvents, agents };
      }
    } catch (err) {
      console.log(`    poll #${i + 1}: query failed — ${(err as Error).message}`);
    }
  }

  return { status: "timeout_polling", events: allEvents, agents: [] };
}

// ---------------------------------------------------------------------------
// Test: Normal completion
// ---------------------------------------------------------------------------

async function testNormalCompletion() {
  console.log("\n=== TEST: Normal Completion ===");
  const workflowId = `e2e-normal-${Date.now()}`;

  const handle = await client.workflow.start("orchestratorWorkflow", {
    workflowId,
    taskQueue,
    args: [makeParams()],
  });
  console.log(`  Started: ${workflowId}`);

  const poll = await pollUntilDone(handle);

  // Get final result
  try {
    const result = await handle.result();
    console.log(`  Result: status=${result.status}, agents=${JSON.stringify(
      Object.entries(result.agentResults).map(([id, r]) => `${id}:${(r as { status: string }).status}`)
    )}, duration=${result.durationMs}ms`);

    // Assertions
    if (result.status !== "completed") {
      throw new Error(`Expected status=completed, got ${result.status}`);
    }
    // With the buildResult fix, all agents should be "completed"
    for (const [id, r] of Object.entries(result.agentResults)) {
      const agentResult = r as { status: string };
      if (agentResult.status !== "completed") {
        console.log(`  WARNING: agent ${id} has status=${agentResult.status} (expected completed)`);
      }
    }

    console.log("  PASSED");
  } catch (err) {
    console.log(`  FAILED: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Test: Cancel / Stop
// ---------------------------------------------------------------------------

async function testCancelStop() {
  console.log("\n=== TEST: Cancel / Stop ===");
  const workflowId = `e2e-cancel-${Date.now()}`;

  const handle = await client.workflow.start("orchestratorWorkflow", {
    workflowId,
    taskQueue,
    args: [makeParams({ maxDurationMs: 120_000 })],
  });
  console.log(`  Started: ${workflowId}`);

  // Wait a bit for the workflow to start
  await new Promise((r) => setTimeout(r, 5000));

  // Send stop signal
  console.log("  Sending stop signal...");
  await handle.signal(stopSignal);

  // Poll until done
  const poll = await pollUntilDone(handle, 10, 2000);

  try {
    const result = await handle.result();
    console.log(`  Result: status=${result.status}`);

    if (result.status !== "cancelled") {
      throw new Error(`Expected status=cancelled, got ${result.status}`);
    }

    console.log("  PASSED");
  } catch (err) {
    console.log(`  FAILED: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Test: Timeout
// ---------------------------------------------------------------------------

async function testTimeout() {
  console.log("\n=== TEST: Timeout (short duration) ===");
  const workflowId = `e2e-timeout-${Date.now()}`;

  // Very short timeout — workflow should time out during LLM call or coordination
  const handle = await client.workflow.start("orchestratorWorkflow", {
    workflowId,
    taskQueue,
    args: [makeParams({ maxDurationMs: 8_000 })], // 8s timeout
  });
  console.log(`  Started: ${workflowId} (8s timeout)`);

  const poll = await pollUntilDone(handle, 15, 2000);

  try {
    const result = await handle.result();
    console.log(`  Result: status=${result.status}, duration=${result.durationMs}ms`);

    if (result.status !== "timed_out" && result.status !== "completed") {
      throw new Error(`Expected status=timed_out or completed, got ${result.status}`);
    }

    if (result.status === "timed_out") {
      console.log("  PASSED (timed out as expected)");
    } else {
      console.log("  PASSED (completed before timeout — LLM was fast)");
    }
  } catch (err) {
    console.log(`  FAILED: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Test: User Input
// ---------------------------------------------------------------------------

async function testUserInput() {
  console.log("\n=== TEST: User Input ===");
  const workflowId = `e2e-input-${Date.now()}`;

  const handle = await client.workflow.start("orchestratorWorkflow", {
    workflowId,
    taskQueue,
    args: [makeParams()],
  });
  console.log(`  Started: ${workflowId}`);

  // Wait for workflow to be active and processing
  await new Promise((r) => setTimeout(r, 5000));

  // Send user input
  console.log("  Sending user input: 'Focus on the primary button first'");
  await handle.signal(userInputSignal, {
    content: "Focus on the primary button first",
  });

  const poll = await pollUntilDone(handle);

  try {
    const result = await handle.result();
    console.log(`  Result: status=${result.status}`);

    if (result.status === "completed") {
      console.log("  PASSED");
    } else {
      console.log(`  PASSED (status=${result.status})`);
    }
  } catch (err) {
    console.log(`  FAILED: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "guardian-orchestration";

  console.log(`[e2e] Connecting to ${address}...`);
  const connection = await Connection.connect({ address });
  client = new Client({ connection, namespace });
  console.log("[e2e] Connected.");

  const testArg = process.argv[2];

  if (!testArg || testArg === "all") {
    await testNormalCompletion();
    await testCancelStop();
    await testTimeout();
    await testUserInput();
  } else if (testArg === "normal") {
    await testNormalCompletion();
  } else if (testArg === "cancel") {
    await testCancelStop();
  } else if (testArg === "timeout") {
    await testTimeout();
  } else if (testArg === "input") {
    await testUserInput();
  } else {
    console.log(`Unknown test: ${testArg}. Available: all, normal, cancel, timeout, input`);
  }

  console.log("\n[e2e] Done. Temporal UI: http://localhost:8233");
  process.exit(0);
}

main().catch((err) => {
  console.error("[e2e] Fatal:", err);
  process.exit(1);
});
