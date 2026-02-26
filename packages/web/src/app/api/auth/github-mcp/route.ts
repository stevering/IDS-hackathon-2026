import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@ai-sdk/mcp";
import crypto from "crypto";
import {
  createGithubMcpOAuthProvider,
  GITHUB_COOKIE_STATE,
  GITHUB_MCP_URL,
} from "@/lib/github-mcp-oauth";
import { RedirectError, getBaseUrl } from "@/lib/figma-mcp-oauth";
import { writeOAuthResult } from "@/lib/oauth-store";

const COOKIE_OAUTH_SESSION = "github_oauth_session";

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const baseUrl = await getBaseUrl();

  // Enforce canonical domain
  const canonicalUrl = new URL(baseUrl);
  const currentHost = request.headers.get("host");
  if (currentHost && currentHost !== canonicalUrl.host) {
    const targetUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, baseUrl);
    if (request.url !== targetUrl.toString()) {
      return NextResponse.redirect(targetUrl);
    }
  }

  const session = request.nextUrl.searchParams.get("session") || "shared-dev-session";

  const state = crypto.randomBytes(16).toString("hex");
  const pendingCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

  const provider = await createGithubMcpOAuthProvider(
    cookieStore,
    (name, value, options) => {
      pendingCookies.push({ name, value, options });
    },
    state,
  );

  // DEBUG: Check client info
  const clientInfo = await provider.clientInformation();
  console.log('[GitHub MCP DEBUG] Client ID present:', !!clientInfo?.client_id);
  console.log('[GitHub MCP DEBUG] Env GITHUB_CLIENT_ID:', !!process.env.GITHUB_CLIENT_ID);

  try {
    await auth(provider, {
      serverUrl: new URL(GITHUB_MCP_URL),
      scope: "repo", // GitHub OAuth scope for MCP (repo full access)
    });

    // Tokens already valid — notify the polling client directly
    writeOAuthResult(session, { type: "github-mcp-auth", success: true });
    return new NextResponse(alreadyConnectedHtml(), { headers: { "Content-Type": "text/html" } });
  } catch (error) {
    if (error instanceof RedirectError) {
      const url = new URL(error.url);
      const redirectState = url.searchParams.get("state") || "";
      const response = new NextResponse(null, {
        status: 307,
        headers: { Location: error.url },
      });

      for (const c of pendingCookies) {
        response.cookies.set(c.name, c.value, c.options as Parameters<typeof response.cookies.set>[2]);
      }

      const isSecure = baseUrl.startsWith("https");
      const sessionCookieOptions = {
        httpOnly: true,
        secure: isSecure,
        sameSite: "lax" as const,
        path: "/",
        maxAge: 600,
      };
      response.cookies.set(GITHUB_COOKIE_STATE, redirectState, sessionCookieOptions);
      response.cookies.set(COOKIE_OAUTH_SESSION, session, sessionCookieOptions);

      return response;
    }

    const msg = error instanceof Error ? error.message : String(error);
    console.error("[GitHub MCP OAuth] Auth error:", msg);
    writeOAuthResult(session, { type: "github-mcp-auth", success: false });
    return new NextResponse(errorPopupHtml(`Init failed: ${msg}`), { headers: { "Content-Type": "text/html" } });
  }
}

function alreadyConnectedHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>GitHub — Connected</title></head><body>
  <script>
    if (window.opener) { try { window.opener.postMessage({ type: 'github-oauth-complete', success: true }, '*'); } catch(e) {} }
    window.close();
  </script>
  </body></html>`;
}

function errorPopupHtml(reason: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>GitHub Auth — Error</title>
  <style>
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0d0d0d; font-family: system-ui, sans-serif; color: #fff; padding: 20px; }
    .card { text-align: center; padding: 40px; background: #161616;
      border: 1px solid rgba(255,80,80,0.2); border-radius: 16px; max-width: 400px; width: 100%; }
    h1 { color: #f87171; margin-bottom: 12px; }
    pre { font-size: 11px; color: rgba(255,255,255,0.4); background: #000; padding: 10px;
      border-radius: 6px; text-align: left; white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1>GitHub Auth Failed</h1>
    <pre>${reason.replace(/</g, "&lt;")}</pre>
  </div>
  <script>
    if (window.opener) {
      try { window.opener.postMessage({ type: 'github-oauth-error', error: ${JSON.stringify(reason)} }, '*'); } catch(e) {}
    }
    window.close();
  </script>
</body></html>`;
}