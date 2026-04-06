import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  BUILTIN_PRESETS,
  DEVICE_ONLINE_TTL_MS,
  buildToolPrefix,
  categoryOf,
  scopeOf,
} from "@guardian/orchestrations";

/**
 * MCP Instances CRUD API.
 *
 * GET  — list all instances enriched with preset/connection/device metadata
 * POST — create a new instance (local MCPs; cloud created via OAuth callback dual-write)
 * PATCH — update label, display_name, enabled, config
 * DELETE — remove instance (+ revoke OAuth token for cloud)
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

// ---------------------------------------------------------------------------
// Helper: generate a unique label for a new instance
// ---------------------------------------------------------------------------

const LABEL_RE = /^[a-z0-9_]+$/;

async function generateUniqueLabel(
  supabase: Awaited<ReturnType<typeof createClient>>,
  baseLabel: string,
): Promise<string> {
  const slug = baseLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const { data: existing } = await supabase
    .from("user_mcp_instances")
    .select("label")
    .like("label", `${slug}%`);
  const taken = new Set((existing ?? []).map((r) => r.label as string));
  if (!taken.has(slug)) return slug;
  for (let i = 2; i < 100; i++) {
    const candidate = `${slug}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug}_${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// POST /api/user/mcp-instances — create a new instance
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const presetType = body.preset_type as string | undefined;
  if (!presetType || !BUILTIN_PRESETS[presetType]) {
    return NextResponse.json({ error: `Unknown preset_type: ${presetType}` }, { status: 400 });
  }

  const preset = BUILTIN_PRESETS[presetType];
  const category = categoryOf(presetType)!;
  const scope = scopeOf(presetType)!;

  // Label: use provided or auto-generate
  let label = body.label as string | undefined;
  if (label) {
    if (!LABEL_RE.test(label)) {
      return NextResponse.json({ error: "Label must match ^[a-z0-9_]+$" }, { status: 400 });
    }
  } else {
    label = await generateUniqueLabel(supabase, preset.preset_slug);
  }

  // Device (required for local)
  const deviceId = body.device_id as string | undefined;
  if (scope === "local" && !deviceId) {
    return NextResponse.json({ error: "device_id required for local instances" }, { status: 400 });
  }

  const config = body.config ?? {};
  const displayName = body.display_name as string | undefined;
  const connectionServerId = scope === "cloud" ? presetType : null;

  const { data, error } = await supabase
    .from("user_mcp_instances")
    .insert({
      user_id: user.id,
      preset_type: presetType,
      category,
      scope,
      label,
      display_name: displayName ?? null,
      device_id: deviceId ?? null,
      config,
      connection_server_id: connectionServerId,
      enabled: true,
    })
    .select("id, label")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: `Label "${label}" is already in use` }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ id: data.id, label: data.label }, { status: 201 });
}

// ---------------------------------------------------------------------------
// PATCH /api/user/mcp-instances?id=<uuid> — update instance fields
// ---------------------------------------------------------------------------

export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const instanceId = new URL(req.url).searchParams.get("id");
  if (!instanceId) return NextResponse.json({ error: "id query param required" }, { status: 400 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const updates: Record<string, unknown> = {};

  if (body.label !== undefined) {
    if (!LABEL_RE.test(body.label)) {
      return NextResponse.json({ error: "Label must match ^[a-z0-9_]+$" }, { status: 400 });
    }
    updates.label = body.label;
  }
  if (body.display_name !== undefined) updates.display_name = body.display_name;
  if (body.enabled !== undefined) updates.enabled = body.enabled;
  if (body.config !== undefined) updates.config = body.config;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  updates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from("user_mcp_instances")
    .update(updates)
    .eq("id", instanceId)
    .eq("user_id", user.id);

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: `Label "${body.label}" is already in use` }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// DELETE /api/user/mcp-instances?id=<uuid> — remove instance + revoke token
// ---------------------------------------------------------------------------

export async function DELETE(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const instanceId = new URL(req.url).searchParams.get("id");
  if (!instanceId) return NextResponse.json({ error: "id query param required" }, { status: 400 });

  // Fetch instance to check if we need to revoke a cloud token
  const { data: inst } = await supabase
    .from("user_mcp_instances")
    .select("connection_server_id, scope")
    .eq("id", instanceId)
    .eq("user_id", user.id)
    .single();

  if (!inst) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  // For cloud instances, also revoke the OAuth token
  if (inst.scope === "cloud" && inst.connection_server_id) {
    try {
      await supabase.rpc("delete_mcp_connection", {
        p_server_id: inst.connection_server_id as string,
      });
    } catch { /* non-fatal — token may already be gone */ }
  }

  // Delete the instance row
  const { error } = await supabase
    .from("user_mcp_instances")
    .delete()
    .eq("id", instanceId)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Also clean up category defaults pointing to this instance
  try {
    await supabase
      .from("user_category_defaults")
      .update({ instance_id: null, updated_at: new Date().toISOString() })
      .eq("instance_id", instanceId)
      .eq("user_id", user.id);
  } catch { /* non-fatal */ }

  return NextResponse.json({ ok: true });
}
