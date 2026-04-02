import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * DELETE /api/user/account
 *
 * Permanently deletes the authenticated user's account and all associated data.
 * Steps:
 *   1. Clean up vault secrets (API keys + MCP connections)
 *   2. Delete auth.users row (cascades to all user tables)
 */
export async function DELETE(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Require explicit confirmation
  const { confirm } = await req.json().catch(() => ({ confirm: false }));
  if (confirm !== true) {
    return NextResponse.json(
      { error: "Missing confirmation. Send { confirm: true } to proceed." },
      { status: 400 }
    );
  }

  const service = createServiceClient();

  // 1. Clean up vault secrets (SECURITY DEFINER RPC — needs service_role)
  const { error: vaultError } = await service.rpc("cleanup_user_vault_secrets", {
    p_user_id: user.id,
  });

  if (vaultError) {
    console.error("[account-delete] Vault cleanup failed:", vaultError);
    return NextResponse.json(
      { error: "Failed to clean up encrypted secrets. Please try again." },
      { status: 500 }
    );
  }

  // 2. Delete auth user (cascades to all user tables via ON DELETE CASCADE)
  const { error: deleteError } = await service.auth.admin.deleteUser(user.id);

  if (deleteError) {
    console.error("[account-delete] User deletion failed:", deleteError);
    return NextResponse.json(
      { error: "Failed to delete account. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
