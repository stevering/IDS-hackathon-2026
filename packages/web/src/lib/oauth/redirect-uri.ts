// RFC 8252 §7.3 — loopback redirect URIs for native apps.
// Registered URIs may use http://127.0.0.1 with ANY port. We store the
// path-only template (e.g. http://127.0.0.1/oauth/callback) and allow any
// port at verification time.
export function isRedirectUriAllowed(registered: string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;
  let u: URL;
  try { u = new URL(candidate); } catch { return false; }
  if (u.hostname !== "127.0.0.1") return false;
  if (u.protocol !== "http:") return false;
  return registered.some((r) => {
    try {
      const ru = new URL(r);
      return ru.protocol === "http:" && ru.hostname === "127.0.0.1" && ru.pathname === u.pathname;
    } catch {
      return false;
    }
  });
}
