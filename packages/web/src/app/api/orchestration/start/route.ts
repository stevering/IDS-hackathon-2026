/**
 * POST /api/orchestration/start
 *
 * Starts a new Temporal orchestration workflow.
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";
import type { StartOrchestrationParams, AgentId } from "@guardian/orchestrations";
import { createLogger } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Check feature flag
  if (process.env.TEMPORAL_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Temporal orchestration is not enabled" },
      { status: 503 }
    );
  }

  const supabase = await createSupabaseUserClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { task, targetAgents, model, maxDurationMs, context } = body as {
    task: string;
    targetAgents: AgentId[];
    model?: string;
    maxDurationMs?: number;
    context?: Record<string, unknown>;
  };

  if (!task || !targetAgents?.length) {
    return NextResponse.json(
      { error: "Missing required fields: task, targetAgents" },
      { status: 400 }
    );
  }

  const workflowId = `orch-${user.id.slice(0, 8)}-${Date.now()}`;
  const log = createLogger("orch/start", { u: user.id.slice(0, 8), wf: workflowId });

  try {
    // Dynamic import to avoid loading Temporal client when feature is disabled
    const { getTemporalClient, getTaskQueue } = await import("@guardian/temporal/client");

    const client = await getTemporalClient();
    const taskQueue = getTaskQueue();

    const params: StartOrchestrationParams = {
      userId: user.id,
      task,
      targetAgents,
      model,
      maxDurationMs,
      context,
    };

    log.info("starting orchestration", {
      agents: targetAgents.map((a: AgentId) => a.shortId).join(","),
      model: model ?? "default",
      task: task.slice(0, 80),
    });

    // Use string workflow name — do NOT import the workflow function directly
    // as it depends on @temporalio/workflow which only works inside the sandbox.
    const handle = await client.workflow.start("orchestratorWorkflow", {
      workflowId,
      taskQueue,
      args: [params],
    });

    log.info("workflow started");

    return NextResponse.json({
      workflowId: handle.workflowId,
      orchestrationId: workflowId,
    });
  } catch (error) {
    log.error(`failed to start: ${error}`);
    return NextResponse.json(
      { error: "Failed to start orchestration" },
      { status: 500 }
    );
  }
}
