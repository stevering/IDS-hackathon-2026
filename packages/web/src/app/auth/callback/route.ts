import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Auth callback handler for Supabase invite magic links.
 * Supabase redirects here after the user clicks the invite link.
 * We exchange the code for a session and redirect to profile completion.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/signup/complete";

  if (!code) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  let response = NextResponse.redirect(new URL(next, request.url));

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
    return NextResponse.redirect(new URL("/login?error=invite_expired", request.url));
  }

  return response;
}
