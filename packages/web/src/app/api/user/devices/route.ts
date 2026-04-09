import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DEVICE_ONLINE_TTL_MS } from "@guardian/orchestrations/mcp";

/**
 * GET /api/user/devices
 *
 * Returns the authenticated user's registered Guardian overlay devices with
 * a computed online/offline status based on last_seen_at.
 *
 * Phase 0: read-only. POST (pairing) and DELETE (unpair) are added in Phase 2.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("user_devices")
    .select(
      "id, device_fingerprint, device_name, os_info, overlay_version, last_seen_at, created_at",
    )
    .order("last_seen_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const now = Date.now();
  const devices = (data ?? []).map((d) => ({
    id: d.id,
    device_fingerprint: d.device_fingerprint,
    device_name: d.device_name,
    os_info: d.os_info,
    overlay_version: d.overlay_version,
    last_seen_at: d.last_seen_at,
    created_at: d.created_at,
    online:
      now - new Date(d.last_seen_at as string).getTime() < DEVICE_ONLINE_TTL_MS,
  }));

  return NextResponse.json({ devices });
}
