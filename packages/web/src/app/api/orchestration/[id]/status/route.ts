/**
 * GET /api/orchestration/[id]/status
 *
 * Query the current state of a Temporal orchestration workflow.
 */

import { NextResponse } from "next/server";
import { createClient as createSupabaseUserClient } from "@/lib/supabase/server";
import type { OrchestrationStatusResponse } from "@guardian/orchestrations";

export const dynamic = "force-dynamic";

export async function GET(
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

  try {
    const { getTemporalClient, statusQuery } = await import("@guardian/temporal");
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId);

    const status: OrchestrationStatusResponse = await handle.query(statusQuery);

    return NextResponse.json(status);
  } catch (error) {
    console.error(`[orchestration/${workflowId}/status] Failed:`, error);
    return NextResponse.json(
      { error: "Failed to query orchestration status" },
      { status: 500 }
    );
  }
}
