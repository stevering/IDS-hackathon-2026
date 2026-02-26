type OAuthResult = {
  type: string;
  success: boolean;
  timestamp: number;
  access_token?: string;
  tokens?: Record<string, string>;
};

// Use globalThis to share state across Turbopack module instances in dev.
// Each route bundle gets its own module scope, but globalThis is truly shared
// across all of them within the same Node.js process.
const g = globalThis as typeof globalThis & { __oauthStore?: Record<string, OAuthResult> };
if (!g.__oauthStore) g.__oauthStore = {};
const store = g.__oauthStore;

export function writeOAuthResult(
  key: string,
  result: Omit<OAuthResult, "timestamp">
): void {
  console.log(`[oauth-store] write key="${key}" type=${result.type} success=${result.success}`);
  store[key] = { ...result, timestamp: Date.now() };
}

export function readOAuthResult(key: string): OAuthResult | null {
  const r = store[key];
  if (r && Date.now() - r.timestamp < 60000) {
    delete store[key];
    console.log(`[oauth-store] read key="${key}" → success=${r.success}`);
    return r;
  }
  console.log(`[oauth-store] read key="${key}" → null (store keys: ${Object.keys(store).join(", ") || "empty"})`);
  return null;
}
