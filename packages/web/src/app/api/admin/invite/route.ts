import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/admin/invite — Send a beta invite to an email address.
 * Admin-only: checks is_admin flag in user metadata.
 */
export async function POST(request: Request) {
  // Verify admin
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.is_admin !== true) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { email } = await request.json();
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const service = createServiceClient();

  // Check if already invited
  const { data: existing } = await service
    .from("beta_invites")
    .select("id, status")
    .eq("email", normalizedEmail)
    .single();

  if (existing && existing.status === "accepted") {
    return NextResponse.json({ error: "User already accepted their invite" }, { status: 409 });
  }

  // Send invite via Supabase Auth (creates user + sends magic link email)
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const { error: inviteError } = await service.auth.admin.inviteUserByEmail(normalizedEmail, {
    redirectTo: `${baseUrl}/auth/callback`,
  });

  if (inviteError) {
    console.error("[Admin Invite] Supabase invite error:", inviteError.message);
    // "User already registered" is fine — they just need to accept
    if (!inviteError.message.includes("already been registered")) {
      return NextResponse.json({ error: inviteError.message }, { status: 500 });
    }
  }

  // Upsert invite record
  await service
    .from("beta_invites")
    .upsert(
      { email: normalizedEmail, invited_by: user.id, status: "pending", invited_at: new Date().toISOString() },
      { onConflict: "email" }
    );

  return NextResponse.json({ ok: true, email: normalizedEmail });
}
