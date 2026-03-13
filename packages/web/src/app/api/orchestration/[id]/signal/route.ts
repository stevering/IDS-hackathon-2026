/**
 * POST /api/orchestration/[id]/signal
 *
 * Sends a signal to a running Temporal orchestration workflow.
 * Supports: userInput, stop
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workflowId } = await params;

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
  const { signal: signalName, payload } = body as {
    signal: string;
    payload?: unknown;
  };

  if (!signalName) {
    return NextResponse.json(
      { error: "Missing required field: signal" },
      { status: 400 }
    );
  }

  try {
    const { getTemporalClient, userInputSignal, stopSignal } = await import("@guardian/temporal/client");
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId);

    switch (signalName) {
      case "userInput":
        await handle.signal(userInputSignal, payload as { content: string; targetAgentId?: string });
        break;

      case "stop":
        await handle.signal(stopSignal);
        break;

      default:
        return NextResponse.json(
          { error: `Unknown signal: ${signalName}` },
          { status: 400 }
        );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`[orchestration/${workflowId}/signal] Failed:`, error);
    return NextResponse.json(
      { error: "Failed to send signal" },
      { status: 500 }
    );
  }
}
