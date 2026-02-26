import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@ai-sdk/mcp";
import {
  createGithubMcpOAuthProvider,
  GITHUB_COOKIE_STATE,
  GITHUB_COOKIE_CODE_VERIFIER,
  GITHUB_MCP_URL,
} from "@/lib/github-mcp-oauth";
import { getBaseUrl } from "@/lib/figma-mcp-oauth";
import { writeOAuthResult } from "@/lib/oauth-store";

const COOKIE_OAUTH_SESSION = "github_oauth_session";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const session = cookieStore.get(COOKIE_OAUTH_SESSION)?.value || "shared-dev-session";
  const savedState = cookieStore.get(GITHUB_COOKIE_STATE)?.value;

  if (!savedState || savedState !== state) {
    console.error("[GitHub MCP OAuth Callback] State mismatch:", {
      savedState,
      state,
      host: request.headers.get("host"),
    });
    writeOAuthResult(session, { type: "github-mcp-auth", success: false });
    return new NextResponse(errorHtml("State mismatch — please retry"), { headers: { "Content-Type": "text/html" } });
  }

  const pendingCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

  const provider = await createGithubMcpOAuthProvider(
    cookieStore,
    (name, value, options) => {
      pendingCookies.push({ name, value, options });
    },
  );

  try {
    await auth(provider, {
      serverUrl: new URL(GITHUB_MCP_URL),
      authorizationCode: code,
      scope: "repo",
    });

    const baseUrl = await getBaseUrl();

    // Extract tokens JSON from pending cookies to relay to the opener via localStorage
    let tokensJson: string | undefined;
    for (const c of pendingCookies) {
      if (c.name === "github_mcp_tokens" && c.value) {
        tokensJson = c.value as string;
      }
    }

    // Write result (including tokens) to oauth-store for polling fallback
    writeOAuthResult(session, { type: "github-mcp-auth", success: true, tokens: tokensJson ? { github_mcp_tokens: tokensJson } : undefined });

    // Return HTML page that stores token in localStorage (for Figma plugin context)
    // and notifies opener, then closes the popup
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>GitHub — Connected</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0d0d0d; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; }
    .card { text-align: center; padding: 48px 40px; background: #161616;
      border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; max-width: 360px; width: 100%; }
    .icon { width: 56px; height: 56px; border-radius: 50%; background: rgba(52,211,153,0.12);
      border: 1px solid rgba(52,211,153,0.3); display: flex; align-items: center; justify-content: center;
      margin: 0 auto 20px; font-size: 24px; }
    h1 { font-size: 20px; font-weight: 600; color: #fff; margin-bottom: 8px; }
    .subtitle { font-size: 14px; color: rgba(255,255,255,0.5); margin-bottom: 24px; line-height: 1.5; }
    .close-hint { display: none; font-size: 13px; color: rgba(255,255,255,0.3);
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px; padding: 10px 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h1>Connected!</h1>
    <p class="subtitle">GitHub is now connected.<br>Returning to the plugin…</p>
    <p class="close-hint" id="close-hint">Authentication complete — you can close this tab.</p>
  </div>
  <script>
    var tokensJson = ${JSON.stringify(tokensJson ?? null)};
    if (tokensJson) {
      try { localStorage.setItem('github_mcp_tokens', tokensJson); } catch(e) {}
    }
    if (window.opener) {
      try { window.opener.postMessage({ type: 'github-oauth-complete', success: true, tokensJson: tokensJson }, '*'); } catch(e) {}
    }
    window.close();
    setTimeout(function() {
      document.getElementById('close-hint').style.display = 'block';
    }, 300);
  </script>
</body>
</html>`;

    const response = new NextResponse(html, {
      headers: { "Content-Type": "text/html" },
    });

    for (const c of pendingCookies) {
      response.cookies.set(c.name, c.value, c.options as Parameters<typeof response.cookies.set>[2]);
    }

    response.cookies.delete(GITHUB_COOKIE_STATE);
    response.cookies.delete(GITHUB_COOKIE_CODE_VERIFIER);
    response.cookies.delete(COOKIE_OAUTH_SESSION);

    return response;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[GitHub MCP OAuth Callback] Error:", msg);
    writeOAuthResult(session, { type: "github-mcp-auth", success: false });
    return new NextResponse(errorHtml(`Auth failed: ${msg}`), { headers: { "Content-Type": "text/html" } });
  }
}

function errorHtml(reason: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>GitHub Auth — Error</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0d0d0d; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; }
    .card { text-align: center; padding: 40px; background: #161616;
      border: 1px solid rgba(255,80,80,0.2); border-radius: 16px; max-width: 400px; width: 100%; }
    .icon { width: 56px; height: 56px; border-radius: 50%; background: rgba(255,80,80,0.1);
      border: 1px solid rgba(255,80,80,0.3); display: flex; align-items: center; justify-content: center;
      margin: 0 auto 20px; font-size: 24px; }
    h1 { font-size: 18px; font-weight: 600; color: #f87171; margin-bottom: 8px; }
    pre { font-size: 11px; color: rgba(255,255,255,0.4); background: rgba(0,0,0,0.3);
      padding: 10px; border-radius: 6px; margin-top: 12px; text-align: left;
      white-space: pre-wrap; word-break: break-all; }
    .hint { font-size: 13px; color: rgba(255,255,255,0.3); margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✗</div>
    <h1>GitHub Auth Failed</h1>
    <pre>${reason.replace(/</g, "&lt;")}</pre>
    <p class="hint" id="hint">This window will close…</p>
  </div>
  <script>
    if (window.opener) {
      try { window.opener.postMessage({ type: 'github-oauth-error', error: ${JSON.stringify(reason)} }, '*'); } catch(e) {}
    }
    window.close();
    setTimeout(function() { document.getElementById('hint').textContent = 'You can close this window.'; }, 500);
  </script>
</body>
</html>`;
}