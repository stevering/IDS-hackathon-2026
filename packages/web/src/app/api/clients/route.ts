import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** GET /api/clients — list all registered clients for the current user.
 *  Use ?active=true to filter to clients seen in the last hour. */
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("user_clients")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const url = new URL(req.url);
  let clients = data ?? [];
  if (url.searchParams.get("active") === "true") {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    clients = clients.filter((c) => c.last_seen_at > oneHourAgo);
  }

  return NextResponse.json({ clients });
}
