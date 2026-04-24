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

  const client = createServerClient(
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY!,
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
                // SameSite=None + Secure requis pour les iframes cross-origin (Figma plugin).
                // Ne pas mettre httpOnly: les cookies Supabase doivent être lisibles
                // par le client JS (createBrowserClient) pour que getUser() fonctionne.
                sameSite: "none",
                secure: true,
                path: "/",
              })
            );
          } catch (err) {
            // Read-only cookie store (Server Component / RSC render): expected.
            // The middleware handles session refresh, so this failure is benign
            // in that context. We still log at debug level so a genuinely
            // broken cookie write in a Route Handler does not stay silent.
            console.debug("[supabase/server] setAll skipped (likely RSC render):", err);
          }
        },
      },
    }
  );

  // Wrap auth.getUser() with retries on transient fetch errors.
  // Docker Supabase (Kong) drops connections when Next.js makes many parallel
  // requests during page load. Retry with increasing delays to spread the load.
  const originalGetUser = client.auth.getUser.bind(client.auth);
  client.auth.getUser = async (...args: Parameters<typeof originalGetUser>) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await originalGetUser(...args);
      const errName = (result.error as { name?: string } | null)?.name;
      if (!result.error || (errName !== "AuthRetryableFetchError" && errName !== "AuthUnknownError")) {
        return result;
      }
      // Spread retries with jitter to avoid thundering herd
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1) + Math.random() * 100));
    }
    return originalGetUser(...args);
  };

  return client;
}
