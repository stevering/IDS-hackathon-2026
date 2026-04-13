import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";

export type MintedSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  user_id: string;
};

// Mints a Supabase session for a known user_id on the server side.
//
// Flow (RFC-compliant from our side, Supabase-native under the hood):
//   1. admin.getUserById → email
//   2. admin.generateLink({ type: 'magiclink' }) → hashed_token
//   3. verifyOtp({ token_hash, type: 'magiclink' }) on a fresh non-persisted
//      client → returns a real Supabase session ({access, refresh} JWTs)
//
// The hashed_token is single-use and expires in ~1h; we exchange it in the
// same request. No magiclink email is ever sent to the user because we
// consume the hash immediately.
export async function mintSupabaseSessionForUser(userId: string): Promise<MintedSession> {
  const admin = createServiceClient();

  const { data: userData, error: userErr } = await admin.auth.admin.getUserById(userId);
  if (userErr || !userData?.user?.email) {
    throw new Error(`mintSession: cannot resolve user ${userId}: ${userErr?.message ?? "no email"}`);
  }
  const email = userData.user.email;

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    throw new Error(`mintSession: generateLink failed: ${linkErr?.message ?? "no hashed_token"}`);
  }
  const tokenHash = linkData.properties.hashed_token;

  // Fresh anon client with no persistence — we only want the session back.
  const anon = createSupabaseClient(
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  if (verifyErr || !verifyData?.session) {
    throw new Error(`mintSession: verifyOtp failed: ${verifyErr?.message ?? "no session"}`);
  }

  const s = verifyData.session;
  return {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_in: s.expires_in ?? 3600,
    expires_at: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600),
    user_id: userId,
  };
}
