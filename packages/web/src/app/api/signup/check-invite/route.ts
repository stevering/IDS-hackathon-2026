import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/signup/check-invite — Check the status of an invite by email.
 * Public endpoint — returns the invite status without revealing sensitive info.
 */
export async function POST(request: Request) {
  const { email } = await request.json();
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ status: "unknown" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const service = createServiceClient();

  const { data: invite } = await service
    .from("beta_invites")
    .select("status")
    .eq("email", normalizedEmail)
    .single();

  if (!invite) {
    return NextResponse.json({ status: "unknown" });
  }

  return NextResponse.json({ status: invite.status });
}
