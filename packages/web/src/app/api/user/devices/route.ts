import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DEVICE_ONLINE_TTL_MS } from "@guardian/orchestrations/mcp";

/**
 * Device (Desktop Companion) registration and listing.
 *
 * GET  — list the user's devices with online/offline status
 * POST — register a new device (or upsert an existing one by fingerprint)
 * DELETE — unregister a device (cascades to its local instances)
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

/**
 * POST /api/user/devices
 *
 * Register a new Desktop Companion device, or upsert an existing one by
 * device_fingerprint. Idempotent — calling twice with the same fingerprint
 * refreshes the row's metadata without creating a duplicate.
 *
 * Body: { device_fingerprint: string; device_name?: string; os_info?: string; overlay_version?: string }
 * Returns: { id, device_fingerprint, device_name, created: boolean }
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const fingerprint = body.device_fingerprint as string | undefined;
  if (!fingerprint || typeof fingerprint !== "string") {
    return NextResponse.json({ error: "device_fingerprint required" }, { status: 400 });
  }

  const deviceName = (body.device_name as string | undefined) ?? "Desktop Companion";
  const osInfo = (body.os_info as string | undefined) ?? null;
  const overlayVersion = (body.overlay_version as string | undefined) ?? null;

  // Check if the device already exists
  const { data: existing } = await supabase
    .from("user_devices")
    .select("id")
    .eq("user_id", user.id)
    .eq("device_fingerprint", fingerprint)
    .maybeSingle();

  if (existing) {
    // Upsert: refresh last_seen_at and metadata
    const { error } = await supabase
      .from("user_devices")
      .update({
        device_name: deviceName,
        os_info: osInfo,
        overlay_version: overlayVersion,
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      id: existing.id,
      device_fingerprint: fingerprint,
      device_name: deviceName,
      created: false,
    });
  }

  // Insert new device
  const { data, error } = await supabase
    .from("user_devices")
    .insert({
      user_id: user.id,
      device_fingerprint: fingerprint,
      device_name: deviceName,
      os_info: osInfo,
      overlay_version: overlayVersion,
    })
    .select("id, device_fingerprint, device_name")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ...data, created: true }, { status: 201 });
}

/**
 * DELETE /api/user/devices?id=<uuid>
 *
 * Unregister a device. The CASCADE on user_mcp_instances(device_id) will
 * remove all local instances attached to this device.
 */
export async function DELETE(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const deviceId = new URL(req.url).searchParams.get("id");
  if (!deviceId) return NextResponse.json({ error: "id query param required" }, { status: 400 });

  const { error } = await supabase
    .from("user_devices")
    .delete()
    .eq("id", deviceId)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
