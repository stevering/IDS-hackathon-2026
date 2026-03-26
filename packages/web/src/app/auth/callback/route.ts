import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Auth callback handler for Supabase invite magic links.
 *
 * Two flows land here:
 * - PKCE (prod): Supabase redirects with ?code=xxx → exchange for session → /signup/complete
 * - Implicit error (local+prod): Supabase redirects with #error=... → no code →
 *   redirect to /login (browser preserves the hash, login page handles it client-side)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  // No code = either an error (hash) or direct access. Redirect to login.
  // The browser preserves the hash fragment during the redirect,
  // so /login receives #error=... and handles it client-side.
  if (!code) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  let response = NextResponse.redirect(new URL("/signup/complete", request.url));

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, {
              ...options,
              sameSite: "none",
              secure: true,
              path: "/",
            })
          );
        },
      },
    }
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[Auth Callback] Error exchanging code:", error.message);
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return response;
}
