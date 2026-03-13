/**
 * POST /api/orchestration/start
 *
 * Starts a new Temporal orchestration workflow.
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";
import type { StartOrchestrationParams, AgentId } from "@guardian/orchestrations";

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
  const { task, targetAgents, maxDurationMs, context } = body as {
    task: string;
    targetAgents: AgentId[];
    maxDurationMs?: number;
    context?: Record<string, unknown>;
  };

  if (!task || !targetAgents?.length) {
    return NextResponse.json(
      { error: "Missing required fields: task, targetAgents" },
      { status: 400 }
    );
  }

  try {
    // Dynamic import to avoid loading Temporal client when feature is disabled
    const { getTemporalClient, getTaskQueue } = await import("@guardian/temporal/client");

    const client = await getTemporalClient();
    const taskQueue = getTaskQueue();

    const params: StartOrchestrationParams = {
      userId: user.id,
      task,
      targetAgents,
      maxDurationMs,
      context,
    };

    const workflowId = `orch-${user.id.slice(0, 8)}-${Date.now()}`;

    // Use string workflow name — do NOT import the workflow function directly
    // as it depends on @temporalio/workflow which only works inside the sandbox.
    const handle = await client.workflow.start("orchestratorWorkflow", {
      workflowId,
      taskQueue,
      args: [params],
    });

    return NextResponse.json({
      workflowId: handle.workflowId,
      orchestrationId: workflowId,
    });
  } catch (error) {
    console.error("[orchestration/start] Failed to start workflow:", error);
    return NextResponse.json(
      { error: "Failed to start orchestration" },
      { status: 500 }
    );
  }
}
