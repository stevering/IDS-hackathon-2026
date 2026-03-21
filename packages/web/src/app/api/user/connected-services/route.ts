import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { MCP_SERVERS } from "@/lib/mcp-registry";

/** GET /api/user/connected-services — list connected MCP services (no secrets). */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("user_mcp_connections")
    .select("id, server_id, scopes, expires_at, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  // Enrich with registry metadata + connection status
  const services = MCP_SERVERS.map((server) => {
    const connection = data?.find((c) => c.server_id === server.id);
    return {
      id: server.id,
      name: server.name,
      description: server.description,
      authPath: server.authPath,
      connected: !!connection,
      expired:
        connection?.expires_at != null &&
        new Date(connection.expires_at) < new Date(),
      scopes: connection?.scopes ?? null,
      connectedAt: connection?.created_at ?? null,
      expiresAt: connection?.expires_at ?? null,
    };
  });

  return NextResponse.json({ services });
}

/** DELETE /api/user/connected-services?server_id=xxx — disconnect a service. */
export async function DELETE(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const serverId = new URL(req.url).searchParams.get("server_id");
  if (!serverId) {
    return NextResponse.json(
      { error: "server_id query param required" },
      { status: 400 },
    );
  }

  const { error } = await supabase.rpc("delete_mcp_connection", {
    p_server_id: serverId,
  });
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
