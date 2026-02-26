import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@ai-sdk/mcp";
import {
  createFigmaMcpOAuthProvider,
  COOKIE_STATE,
  COOKIE_CODE_VERIFIER,
  COOKIE_CLIENT_INFO,
  COOKIE_AUTH_TOKEN
} from "@/lib/figma-mcp-oauth";
import {getBaseUrl} from "@/lib/get-base-url";
import { writeOAuthResult } from "@/lib/oauth-store";

const COOKIE_OAUTH_SESSION = "figma_oauth_session";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const session = cookieStore.get(COOKIE_OAUTH_SESSION)?.value || "shared-dev-session";
  const savedState = cookieStore.get(COOKIE_STATE)?.value;

  if (!savedState || savedState !== state) {
    const allCookies = cookieStore.getAll().map(c => c.name).join(", ");
    console.error("[Figma MCP OAuth Callback] State mismatch:", {
      savedState,
      state,
      host: request.headers.get("host"),
      cookies: allCookies
    });
    writeOAuthResult(session, { type: "figma-mcp-auth", success: false });
    return new NextResponse(errorHtml("State mismatch — please retry"), { headers: { "Content-Type": "text/html" } });
  }

  const pendingCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

  const provider = await createFigmaMcpOAuthProvider(
    cookieStore,
    (name, value, options) => {
      pendingCookies.push({ name, value, options });
    },
  );

  // Detect if we have a DCR client (same logic as in the auth route)
  const dcrClientRaw = cookieStore.get(COOKIE_CLIENT_INFO)?.value;
  let hasDcrClient = false;
  if (dcrClientRaw) {
    try {
      const dcrClient = JSON.parse(dcrClientRaw);
      hasDcrClient = !!dcrClient.client_id && !process.env.FIGMA_CLIENT_ID;
      if (dcrClient.client_id && dcrClient.client_id !== process.env.FIGMA_CLIENT_ID) {
        hasDcrClient = true;
      }
    } catch {
      // ignore
    }
  }

  const useMcpMode = hasDcrClient;
  console.log("[Figma MCP OAuth Callback] Mode:", useMcpMode ? "MCP (mcp:connect)" : "Standard (fallback)");

  try {
    if (useMcpMode) {
      // Native MCP OAuth: exchange code using mcp.figma.com issuer
      await auth(provider, {
        serverUrl: new URL("https://mcp.figma.com"),
        authorizationCode: code,
        scope: "mcp:connect",
      });
    } else {
      // Standard fallback: exchange code using api.figma.com issuer
      await auth(provider, {
        serverUrl: new URL("https://api.figma.com"),
        authorizationCode: code,
        scope: process.env.FIGMA_OAUTH_SCOPES || "current_user:read,file_content:read,file_metadata:read,projects:read",
        fetchFn: async (url, options) => {
          const response = await fetch(url, options);
          if (url.toString().includes(".well-known/oauth-authorization-server")) {
            const data = await response.json();
            return new Response(
              JSON.stringify({
                ...data,
                authorization_endpoint: "https://www.figma.com/oauth",
              }),
              {
                status: response.status,
                headers: response.headers,
              }
            );
          }
          return response;
        },
      });
    }

    const baseUrl = await getBaseUrl();

    // Extract tokens JSON from pending cookies to relay to the opener via localStorage
    let tokensJson: string | undefined;
    for (const c of pendingCookies) {
      if (c.name === "figma_mcp_tokens" && c.value) {
        tokensJson = c.value as string;
      }
    }

    // Write result (including tokens) to oauth-store for polling fallback
    writeOAuthResult(session, { type: "figma-mcp-auth", success: true, tokens: tokensJson ? { figma_mcp_tokens: tokensJson } : undefined });

    // Return HTML page that notifies opener and closes the popup
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Figma — Connected</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0d0d0d; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; }
    .card { text-align: center; padding: 48px 40px; background: #161616;
      border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; max-width: 360px; width: 100%; }
    .icon { width: 56px; height: 56px; border-radius: 50%; background: rgba(162,89,255,0.12);
      border: 1px solid rgba(162,89,255,0.3); display: flex; align-items: center; justify-content: center;
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
    <p class="subtitle">Figma is now connected.<br>Returning to the plugin…</p>
    <p class="close-hint" id="close-hint">Authentication complete — you can close this tab.</p>
  </div>
  <script>
    var tokensJson = ${JSON.stringify(tokensJson ?? null)};
    if (tokensJson) {
      try { localStorage.setItem('figma_mcp_tokens', tokensJson); } catch(e) {}
    }
    if (window.opener) {
      try { window.opener.postMessage({ type: 'figma-oauth-complete', success: true, tokensJson: tokensJson }, '*'); } catch(e) {}
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

    response.cookies.delete(COOKIE_STATE);
    response.cookies.delete(COOKIE_CODE_VERIFIER);
    response.cookies.delete(COOKIE_AUTH_TOKEN);
    response.cookies.delete(COOKIE_OAUTH_SESSION);

    return response;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[Figma MCP OAuth Callback] Error:", msg);
    writeOAuthResult(session, { type: "figma-mcp-auth", success: false });
    return new NextResponse(errorHtml(`Auth failed: ${msg}`), { headers: { "Content-Type": "text/html" } });
  }
}

function errorHtml(reason: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Figma Auth — Error</title>
  <style>
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0d0d0d; font-family: system-ui, sans-serif; color: #fff; padding: 20px; }
    .card { text-align: center; padding: 40px; background: #161616;
      border: 1px solid rgba(162,89,255,0.2); border-radius: 16px; max-width: 400px; width: 100%; }
    h1 { color: #c084fc; margin-bottom: 12px; }
    pre { font-size: 11px; color: rgba(255,255,255,0.4); background: #000; padding: 10px;
      border-radius: 6px; text-align: left; white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Figma Auth Failed</h1>
    <pre>${reason.replace(/</g, "&lt;")}</pre>
  </div>
  <script>
    if (window.opener) {
      try { window.opener.postMessage({ type: 'figma-oauth-error', error: ${JSON.stringify(reason)} }, '*'); } catch(e) {}
    }
    window.close();
    setTimeout(function() {
      document.querySelector('p') && (document.querySelector('p').textContent = 'You can close this window.');
    }, 500);
  </script>
</body></html>`;
}
