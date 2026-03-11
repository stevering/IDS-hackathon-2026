import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client pour les Client Components ("use client").
 * Utilise la clé anon — safe à exposer au browser.
 *
 * cookieOptions.sameSite = 'none' + secure = true obligatoires pour que les
 * cookies de session soient envoyés dans les iframes cross-origin (plugin Figma).
 * Sans ça, Chrome applique SameSite=Lax par défaut et bloque les cookies
 * dans les requêtes cross-site issues de l'iframe.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY!,
    {
      cookieOptions: {
        sameSite: "none",
        secure: true,
      },
      // isSingleton: false évite de réutiliser un client en cache créé sans
      // cookieOptions (ce qui arriverait si le module est initialisé par Next.js
      // avant que les options soient appliquées).
      isSingleton: false,
    }
  );
}
