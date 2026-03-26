import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/signup/complete — Complete profile after invite acceptance.
 * Sets password, saves profile metadata, records CGU acceptance with audit trail.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { firstName, lastName, workRole, password, cguVersion } = await request.json();

  // Validate required fields
  if (!firstName?.trim() || !lastName?.trim() || !workRole?.trim() || !password || !cguVersion) {
    return NextResponse.json({ error: "All fields are required" }, { status: 400 });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  // Update user profile metadata + set password
  const { error: updateError } = await supabase.auth.updateUser({
    password,
    data: {
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      work_role: workRole.trim(),
      profile_completed: true,
    },
  });

  if (updateError) {
    console.error("[Signup Complete] Update user error:", updateError.message);
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Record CGU acceptance with audit trail (service client for RLS bypass)
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
  const userAgent = request.headers.get("user-agent") ?? "unknown";

  const service = createServiceClient();

  const { error: cguError } = await service
    .from("cgu_acceptances")
    .insert({
      user_id: user.id,
      version: cguVersion,
      ip_address: ip,
      user_agent: userAgent,
    });

  if (cguError) {
    console.error("[Signup Complete] CGU acceptance error:", cguError.message);
    // Non-blocking — profile is already saved
  }

  // Mark invite as accepted
  await service
    .from("beta_invites")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("email", user.email?.toLowerCase());

  return NextResponse.json({ ok: true });
}
