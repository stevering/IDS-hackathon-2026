/**
 * Ensures a user_mcp_instances row exists for a cloud MCP connection.
 *
 * Called by OAuth callbacks after upsert_mcp_connection succeeds.
 * If a row already exists for (user_id, connection_server_id), it's left untouched.
 * If not, a new row is created with a default label derived from the preset slug.
 *
 * This dual-write bridges the legacy user_mcp_connections table (Vault tokens)
 * with the new user_mcp_instances table (unified registry).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { BUILTIN_PRESETS, categoryOf, scopeOf } from "@guardian/orchestrations/mcp";

export async function ensureMCPInstance(
  supabase: SupabaseClient,
  userId: string,
  serverId: string,
): Promise<void> {
  const preset = BUILTIN_PRESETS[serverId];
  if (!preset) return;

  const category = categoryOf(serverId);
  const scope = scopeOf(serverId);
  if (!category || !scope || scope !== "cloud") return;

  // Check if an instance already exists for this connection
  const { data: existing } = await supabase
    .from("user_mcp_instances")
    .select("id")
    .eq("user_id", userId)
    .eq("connection_server_id", serverId)
    .limit(1);

  if (existing && existing.length > 0) return;

  // Generate a unique label
  const baseSlug = preset.preset_slug;
  const { data: allLabels } = await supabase
    .from("user_mcp_instances")
    .select("label")
    .eq("user_id", userId)
    .like("label", `${baseSlug}%`);

  const taken = new Set((allLabels ?? []).map((r) => r.label as string));
  let label = baseSlug;
  if (taken.has(label)) {
    for (let i = 2; i < 100; i++) {
      const candidate = `${baseSlug}_${i}`;
      if (!taken.has(candidate)) { label = candidate; break; }
    }
  }

  const { error } = await supabase
    .from("user_mcp_instances")
    .insert({
      user_id: userId,
      preset_type: serverId,
      category,
      scope,
      label,
      display_name: preset.display_name,
      connection_server_id: serverId,
      enabled: true,
    });

  if (error) {
    console.error(`[mcp-instance-sync] Failed to create instance for ${serverId}:`, error.message);
  } else {
    console.log(`[mcp-instance-sync] Created instance "${label}" for ${serverId}`);
  }
}
