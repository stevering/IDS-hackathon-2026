/**
 * Presence monitoring activity.
 *
 * Checks whether a specific plugin client is still connected
 * via the Supabase Realtime presence channel.
 */

import { createClient } from "@supabase/supabase-js";

export async function checkPresence(params: {
  userId: string;
  pluginClientId: string;
}): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.STORAGE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return false;
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const channel = supabase.channel(`guardian:execute:${params.userId}`);

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      channel.unsubscribe();
      resolve(false);
    }, 5_000);

    channel
      .on("presence", { event: "sync" }, () => {
        const presenceState = channel.presenceState();
        const clients = Object.values(presenceState).flat();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const found = clients.some((c: any) => c.clientId === params.pluginClientId);
        clearTimeout(timer);
        channel.unsubscribe();
        resolve(found);
      })
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        // Trigger a presence sync
        channel.track({});
      });
  });
}
