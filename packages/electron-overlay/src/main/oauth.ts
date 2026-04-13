/**
 * OAuth 2.0 + PKCE client for the Guardian Desktop Companion.
 *
 * Flow (RFC 6749 Authorization Code + RFC 7636 PKCE + RFC 8252):
 *   1. generate code_verifier (random 32 bytes → base64url)
 *   2. compute code_challenge = BASE64URL(SHA256(code_verifier))
 *   3. choose redirect strategy:
 *        - Dev (unpackaged): spawn a loopback HTTP server on 127.0.0.1:<port>
 *          and use http://127.0.0.1:<port>/oauth/callback (RFC 8252 §7.3).
 *          Reliable on macOS — custom protocols don't route to the right dev
 *          Electron binary when multiple apps share com.github.electron.
 *        - Packaged: use guardian://oauth/callback (custom scheme, §7.1).
 *   4. open the consent page in the user's browser
 *   5. callback arrives → extract code + state → POST /api/oauth/token
 */

import { app, shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

const CLIENT_ID = "guardian_companion";
const DEEP_LINK_REDIRECT = "guardian://oauth/callback";
const SCOPE = "companion";
const PAIRING_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

// Use the loopback flow in dev (unpackaged). In packaged builds,
// app.isPackaged is true and the custom scheme path kicks in.
function shouldUseLoopback(): boolean {
  return !app.isPackaged;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type TokenResponse = {
  access_token: string;
  supabase_refresh_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  user_id: string;
  device_id: string | null;
  supabase_url: string;
  supabase_anon_key: string;
};

type PendingExchange = {
  state: string;
  verifier: string;
  redirectUri: string;
  resolve: (r: TokenResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  cloudUrl: string;
  loopbackServer: Server | null;
};

// One in-flight pairing at a time; simpler + matches the UX (only one browser
// tab can win). Any new pairing cancels the previous one.
let pending: PendingExchange | null = null;

export function isPairingInProgress(): boolean {
  return pending !== null;
}

export async function startPairingFlow(params: {
  cloudUrl: string;
  deviceFingerprint: string;
  deviceName: string;
}): Promise<TokenResponse> {
  cancelPairing(new Error("Superseded by a new pairing attempt"));

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier, "ascii").digest());
  const state = base64url(randomBytes(16));

  // Pick the redirect strategy. Loopback HTTP in dev, custom scheme in prod.
  let redirectUri: string;
  let loopbackServer: Server | null = null;

  if (shouldUseLoopback()) {
    loopbackServer = await startLoopbackServer();
    const port = (loopbackServer.address() as AddressInfo).port;
    redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    console.log(`[oauth] Dev mode — loopback redirect on ${redirectUri}`);
  } else {
    redirectUri = DEEP_LINK_REDIRECT;
  }

  const url = new URL("/oauth/authorize", params.cloudUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("device_fingerprint", params.deviceFingerprint);
  url.searchParams.set("device_name", params.deviceName);

  console.log(`[oauth] Opening browser: ${url.toString()}`);

  const promise = new Promise<TokenResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending?.loopbackServer) pending.loopbackServer.close();
      pending = null;
      reject(new Error("Pairing timed out — the user didn't complete it within 5 minutes"));
    }, PAIRING_TIMEOUT_MS);
    pending = { state, verifier, redirectUri, resolve, reject, timer, cloudUrl: params.cloudUrl, loopbackServer };
  });

  await shell.openExternal(url.toString());
  return promise;
}

function startLoopbackServer(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400); res.end("Bad Request"); return;
      }
      const reqUrl = new URL(req.url, `http://127.0.0.1`);
      if (!reqUrl.pathname.endsWith("/oauth/callback")) {
        res.writeHead(404); res.end("Not Found"); return;
      }

      const error = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code");
      const state = reqUrl.searchParams.get("state");

      if (error) {
        respondSuccessPage(res, `Authorization denied: ${error}. You can close this tab.`);
        cancelPairing(new Error(`Authorization denied: ${error}`));
        return;
      }
      if (!code || !state) {
        respondSuccessPage(res, "Missing code or state in callback. You can close this tab.");
        cancelPairing(new Error("Missing code or state"));
        return;
      }

      // Respond to the browser first so the user sees success, then finish the
      // exchange (the response is flushed before we async-shutdown the server).
      respondSuccessPage(res, "Guardian is now paired with this device. You can close this tab and return to the app.");
      void finalizePairing(`http://127.0.0.1/oauth/callback?${reqUrl.searchParams.toString()}`);
    });
    // Port 0 → OS picks a free port.
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function respondSuccessPage(res: Parameters<Parameters<typeof createServer>[0]>[1], message: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>Guardian</title><style>
    body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f7f9;color:#222}
    .card{background:white;padding:40px;border-radius:12px;max-width:420px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.06)}
    h1{margin:0 0 12px;font-size:22px}p{margin:0;color:#555;line-height:1.5}</style></head>
    <body><div class="card"><h1>Guardian Companion</h1><p>${message}</p></div></body></html>`);
}

async function finalizePairing(rawUrl: string): Promise<void> {
  if (!pending) return;
  const { loopbackServer } = pending;
  try {
    await handleDeepLinkCallback(rawUrl);
  } finally {
    // Shut the loopback server down a moment after the browser got its response.
    setTimeout(() => loopbackServer?.close(), 500);
  }
}

export function cancelPairing(reason: Error): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  const p = pending;
  pending = null;
  p.loopbackServer?.close();
  p.reject(reason);
}

/**
 * Invoked on:
 *  - macOS `open-url` event (guardian:// scheme) in packaged builds
 *  - Windows/Linux `second-instance` argv
 *  - Dev loopback HTTP server when it receives /oauth/callback
 */
export async function handleDeepLinkCallback(rawUrl: string): Promise<void> {
  if (!pending) {
    console.warn("[oauth] Received callback but no pairing in progress:", rawUrl);
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    cancelPairing(new Error(`Invalid callback URL: ${rawUrl}`));
    return;
  }

  const isValidScheme =
    (parsed.protocol === "guardian:" && parsed.pathname.endsWith("/callback")) ||
    ((parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.pathname.endsWith("/oauth/callback"));
  if (!isValidScheme) {
    console.warn("[oauth] Unrelated callback URL:", rawUrl);
    return;
  }

  const error = parsed.searchParams.get("error");
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");

  if (error) {
    cancelPairing(new Error(`Authorization denied: ${error}`));
    return;
  }
  if (!code || state !== pending.state) {
    cancelPairing(new Error("Missing code or state mismatch (possible CSRF)"));
    return;
  }

  const { verifier, cloudUrl, redirectUri, resolve, timer, loopbackServer } = pending;
  try {
    const tokens = await exchangeCodeForTokens({
      cloudUrl,
      code,
      verifier,
      redirectUri,
    });
    clearTimeout(timer);
    pending = null;
    loopbackServer?.close();
    resolve(tokens);
  } catch (e) {
    cancelPairing(e as Error);
  }
}

export async function exchangeCodeForTokens(params: {
  cloudUrl: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const res = await fetch(new URL("/api/oauth/token", params.cloudUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`token exchange failed: ${res.status} ${body}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function refreshAccessToken(params: {
  cloudUrl: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const res = await fetch(new URL("/api/oauth/token", params.cloudUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`refresh failed: ${res.status} ${body}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function revokeRefreshToken(params: {
  cloudUrl: string;
  refreshToken: string;
}): Promise<void> {
  await fetch(new URL("/api/oauth/revoke", params.cloudUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: params.refreshToken }),
  }).catch(() => { /* best-effort; local clearSession still runs */ });
}
