import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  BUILTIN_PRESETS,
  DEVICE_ONLINE_TTL_MS,
  buildToolPrefix,
} from "@guardian/orchestrations";

/**
 * GET /api/user/mcp-instances
 *
 * Returns the authenticated user's MCP instances enriched with:
 *   - preset metadata (display_name, category, scope, transport, is_template)
 *   - connection status (for cloud: is the OAuth token present and not expired?)
 *   - device online state (for local: is last_seen_at recent?)
 *   - computed tool prefix
 *
 * Phase 0: read-only. POST/PATCH/DELETE are added in Phase 3.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Load instances (RLS scopes to this user automatically)
  const { data: instances, error: instErr } = await supabase
    .from("user_mcp_instances")
    .select(
      "id, preset_type, category, scope, label, display_name, device_id, config, connection_server_id, enabled, created_at, updated_at",
    )
    .order("created_at", { ascending: true });

  if (instErr) {
    return NextResponse.json({ error: instErr.message }, { status: 500 });
  }

  // Load devices in parallel (for enriching local instances)
  const { data: devices } = await supabase
    .from("user_devices")
    .select("id, device_name, last_seen_at");

  // Load cloud OAuth connections (for enriching cloud instances)
  const { data: connections } = await supabase
    .from("user_mcp_connections")
    .select("server_id, scopes, expires_at, created_at");

  // Load category defaults
  const { data: defaults } = await supabase
    .from("user_category_defaults")
    .select("category, instance_id");

  const now = Date.now();
  const deviceById = new Map(
    (devices ?? []).map((d) => [d.id as string, d]),
  );
  const connByServerId = new Map(
    (connections ?? []).map((c) => [c.server_id as string, c]),
  );

  const enriched = (instances ?? []).map((inst) => {
    const preset = BUILTIN_PRESETS[inst.preset_type as string];
    const device = inst.device_id
      ? deviceById.get(inst.device_id as string)
      : undefined;
    const connection = inst.connection_server_id
      ? connByServerId.get(inst.connection_server_id as string)
      : undefined;

    const deviceOnline = device
      ? now - new Date(device.last_seen_at as string).getTime() <
        DEVICE_ONLINE_TTL_MS
      : null;

    const tokenExpired =
      connection?.expires_at != null &&
      new Date(connection.expires_at as string).getTime() < now;

    // Instance considered "ready" when all required pieces are in place.
    const ready =
      inst.scope === "cloud"
        ? connection != null && !tokenExpired
        : device != null && deviceOnline === true;

    return {
      id: inst.id,
      preset_type: inst.preset_type,
      preset: preset
        ? {
            display_name: preset.display_name,
            description: preset.description,
            preset_slug: preset.preset_slug,
            transport: preset.transport,
            is_template: preset.is_template,
            oauth_auth_path: preset.oauth_auth_path ?? null,
          }
        : null,
      category: inst.category,
      scope: inst.scope,
      label: inst.label,
      display_name: inst.display_name,
      tool_prefix: buildToolPrefix(
        inst.preset_type as string,
        inst.label as string,
      ),
      device: device
        ? {
            id: device.id,
            name: device.device_name,
            last_seen_at: device.last_seen_at,
            online: deviceOnline,
          }
        : null,
      connection: connection
        ? {
            server_id: inst.connection_server_id,
            scopes: connection.scopes,
            expires_at: connection.expires_at,
            connected_at: connection.created_at,
            expired: tokenExpired,
          }
        : null,
      config: inst.config,
      enabled: inst.enabled,
      ready,
      created_at: inst.created_at,
      updated_at: inst.updated_at,
    };
  });

  const defaultsMap = {
    design: null as string | null,
    code: null as string | null,
  };
  for (const d of defaults ?? []) {
    const cat = d.category as string;
    if (cat === "design" || cat === "code") {
      defaultsMap[cat] = (d.instance_id as string | null) ?? null;
    }
  }

  return NextResponse.json({
    instances: enriched,
    defaults: defaultsMap,
  });
}
