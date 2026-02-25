type OAuthResult = {
  type: string;
  success: boolean;
  timestamp: number;
  access_token?: string;
  tokens?: Record<string, string>;
};

const store: Record<string, OAuthResult> = {};

export function writeOAuthResult(
  key: string,
  result: Omit<OAuthResult, "timestamp">
): void {
  store[key] = { ...result, timestamp: Date.now() };
}

export function readOAuthResult(key: string): OAuthResult | null {
  const r = store[key];
  if (r && Date.now() - r.timestamp < 60000) {
    delete store[key];
    return r;
  }
  return null;
}
