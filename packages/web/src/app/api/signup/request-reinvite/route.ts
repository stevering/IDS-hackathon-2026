import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/signup/request-reinvite — Re-send an invitation to an email.
 * Public endpoint (no auth required) — only works if the email already has a pending invite.
 */
export async function POST(request: Request) {
  const { email } = await request.json();
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const service = createServiceClient();

  // Only re-invite if the email has a pending invite (prevents abuse)
  const { data: invite } = await service
    .from("beta_invites")
    .select("id, status")
    .eq("email", normalizedEmail)
    .single();

  if (!invite) {
    // Don't reveal whether the email exists — always return success
    return NextResponse.json({ ok: true });
  }

  if (invite.status === "accepted") {
    return NextResponse.json({ ok: true, alreadyAccepted: true });
  }

  // Delete the existing user and re-invite from scratch
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

  // Find the existing user to delete them
  const { data: { users } } = await service.auth.admin.listUsers();
  const existingUser = users?.find((u) => u.email?.toLowerCase() === normalizedEmail);
  if (existingUser) {
    await service.auth.admin.deleteUser(existingUser.id);
  }

  // Re-send invite (creates a fresh user + sends email)
  const { error: inviteError } = await service.auth.admin.inviteUserByEmail(normalizedEmail, {
    redirectTo: `${baseUrl}/auth/callback`,
  });

  if (inviteError) {
    console.error("[Re-invite] Error:", inviteError.message);
  }

  // Reset invite status to pending
  await service
    .from("beta_invites")
    .update({ status: "pending", invited_at: new Date().toISOString() })
    .eq("email", normalizedEmail);

  return NextResponse.json({ ok: true });
}
