/**
 * Persistence activity — saves orchestration state to Supabase.
 */

import { createClient } from "@supabase/supabase-js";

export async function saveOrchestrationState(params: {
  orchestrationId: string;
  status: string;
  agentResults: Record<string, unknown>;
  durationMs: number;
  userId: string;
}): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.warn("[persistence] Supabase credentials not configured, skipping save");
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { error } = await supabase.from("orchestrations").upsert({
    id: params.orchestrationId,
    user_id: params.userId,
    status: params.status,
    agent_results: params.agentResults,
    duration_ms: params.durationMs,
    completed_at: params.status !== "active" ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.error("[persistence] Failed to save orchestration state:", error.message);
  }
}
