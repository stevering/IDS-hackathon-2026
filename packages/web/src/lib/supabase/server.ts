import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { CookieOptions } from "@supabase/ssr";

/**
 * Supabase client pour Server Components, Route Handlers et Server Actions.
 *
 * SameSite=None + Secure obligatoire pour que les cookies de session
 * fonctionnent dans les iframes cross-origin (plugin Figma).
 * Chrome accepte Secure même en HTTP sur localhost.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options?: CookieOptions }[]
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, {
                ...options,
                sameSite: "none",
                secure: true,
                httpOnly: true,
                path: "/",
              })
            );
          } catch {
            // Ignoré dans les Server Components (cookies en lecture seule).
            // Le middleware se charge du refresh de session.
          }
        },
      },
    }
  );
}
