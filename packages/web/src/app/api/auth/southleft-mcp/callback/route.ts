import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@ai-sdk/mcp";
import {
  createSouthleftMcpOAuthProvider,
  SOUTHLEFT_COOKIE_STATE,
  SOUTHLEFT_COOKIE_CODE_VERIFIER,
  SOUTHLEFT_MCP_URL,
} from "@/lib/southleft-mcp-oauth";
import { writeOAuthResult } from "@/lib/oauth-store";

import {getBaseUrl} from "@/lib/get-base-url";

export async function GET(request: NextRequest) {
  console.log("[Southleft Callback] ===== CALLBACK STARTED =====");
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  console.log("[Southleft Callback] URL params - code:", !!code, "state:", !!state);

  const COOKIE_OAUTH_SESSION = "southleft_oauth_session";
  let cookieStore = await cookies();
  const session = cookieStore.get(COOKIE_OAUTH_SESSION)?.value || 'shared-dev-session';

  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  cookieStore = await cookies();
  const savedState = cookieStore.get(SOUTHLEFT_COOKIE_STATE)?.value;

  if (!savedState || savedState !== state) {
    console.error("[Southleft MCP OAuth Callback] State mismatch:", {
      savedState,
      receivedState: state,
      host: request.headers.get("host"),
    });
    return NextResponse.json({
      error: "Invalid state",
      details: { savedState: savedState || "missing", receivedState: state || "missing" },
    }, { status: 400 });
  }

  const pendingCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

  const provider = await createSouthleftMcpOAuthProvider(
    cookieStore,
    (name, value, options) => {
      pendingCookies.push({ name, value, options });
    },
  );

  try {
    console.log("[Southleft Callback] Calling auth()...");
    await auth(provider, {
      serverUrl: new URL(SOUTHLEFT_MCP_URL),
      authorizationCode: code,
      scope: "file_content:read,library_content:read,file_variables:read",
    });
    console.log("[Southleft Callback] Auth successful, preparing response...");

    const baseUrl = await getBaseUrl();

    // Extract access token from pending cookies
    let accessToken: string | undefined;
    for (const c of pendingCookies) {
      if (c.name === 'southleft_mcp_tokens' && c.value) {
        try {
          const tokens = JSON.parse(c.value as string);
          accessToken = tokens.access_token || tokens.accessToken;
        } catch (e) {
          console.error("[Southleft Callback] Error parsing tokens:", e);
        }
      }
    }

    // Return HTML page that sets localStorage and redirects
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Auth Success</title>
</head>
<body>
    <script>
        if (${JSON.stringify(accessToken)}) {
            localStorage.setItem('southleft_access_token', ${JSON.stringify(accessToken)});
        }
        window.location.href = '${baseUrl}/southleft-auth-success.html';
    </script>
</body>
</html>
    `;

    const response = new NextResponse(html, {
      headers: { 'Content-Type': 'text/html' },
    });

    // Still set cookies for server-side auth
    for (const c of pendingCookies) {
      response.cookies.set(c.name, c.value, c.options as Parameters<typeof response.cookies.set>[2]);
    }

    response.cookies.delete(SOUTHLEFT_COOKIE_STATE);
    response.cookies.delete(SOUTHLEFT_COOKIE_CODE_VERIFIER);
    response.cookies.delete(COOKIE_OAUTH_SESSION);

    // Send tokens to set-oauth-result (use shared key for dev)
    console.log("[Southleft Callback] Sending tokens to set-oauth-result");
    // Extract token values from pending cookies
    const tokens: Record<string, string> = {};
    for (const c of pendingCookies) {
      console.log("[Southleft Callback] Checking cookie:", c.name, "value present:", !!c.value);
      if (c.name === 'southleft_mcp_tokens' && c.value) {
        tokens.southleft_mcp_tokens = c.value as string;
        console.log("[Southleft Callback] Found southleft_mcp_tokens");
      }
      if (c.name === 'southleft_mcp_client_info' && c.value) {
        tokens.southleft_mcp_client_info = c.value as string;
        console.log("[Southleft Callback] Found southleft_mcp_client_info");
      }
    }

    console.log("[Southleft Callback] Tokens to send:", Object.keys(tokens));

    if (Object.keys(tokens).length > 0) {
      console.log("[Southleft Callback] Writing result to oauth-store");
      writeOAuthResult(session, {
        type: 'southleft-mcp-auth',
        success: true,
        access_token: accessToken,
        tokens: tokens,
      });
      console.log("[Southleft Callback] oauth-store written, access_token present:", !!accessToken);
    } else {
      console.log("[Southleft Callback] No tokens found to store");
    }

    return response;
  } catch (error) {
    console.error("[Southleft MCP OAuth Callback] Error:", error);
    const baseUrl = await getBaseUrl();
    const doneUrl = new URL("/", baseUrl);
    doneUrl.searchParams.set("auth", "failed");
    doneUrl.searchParams.set("source", "southleft-mcp");
    doneUrl.searchParams.set("popup", "true");
    return NextResponse.redirect(doneUrl);
  }
}
