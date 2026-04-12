/**
 * Broadcast helpers for notifying Desktop Companions of instance changes.
 *
 * When a local instance is created, toggled, or removed in the DB, the
 * webapp publishes an INSTANCE_CHANGED_EVENT on guardian:devices:${userId}.
 * The matching companion hot-adds/removes its MCP client so the user
 * doesn't have to restart anything.
 *
 * Uses the Supabase anon key (broadcast channels don't require a user session).
 */

import { createClient } from "@supabase/supabase-js";
import {
  devicesChannelName,
  INSTANCE_CHANGED_EVENT,
  type InstanceChangedBroadcast,
} from "@guardian/orchestrations/mcp";

function getAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.STORAGE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * Broadcast an instance change to the user's companions.
 * Fire-and-forget: errors are logged but not thrown (non-critical path —
 * the companion will also pick up the change on its next config refetch).
 */
export async function broadcastInstanceChange(
  userId: string,
  payload: InstanceChangedBroadcast,
): Promise<void> {
  const supabase = getAnonClient();
  if (!supabase) return;

  const channel = supabase.channel(devicesChannelName(userId));
  try {
    await new Promise<void>((resolve) => {
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") resolve();
      });
      // Give up if subscription takes more than 3s
      setTimeout(resolve, 3_000);
    });
    await channel.send({
      type: "broadcast",
      event: INSTANCE_CHANGED_EVENT,
      payload,
    });
  } catch (err) {
    console.warn("[broadcast] instance-change failed:", err);
  } finally {
    try { await supabase.removeChannel(channel); } catch { /* ignore */ }
  }
}
