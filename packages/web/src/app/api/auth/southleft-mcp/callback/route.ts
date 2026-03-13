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

function requestOrigin(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto") || (request.nextUrl.protocol.replace(":", ""));
  const host = request.headers.get("host") || request.nextUrl.host;
  return `${proto}://${host}`;
}

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

  const origin = requestOrigin(request);
  const provider = await createSouthleftMcpOAuthProvider(
    cookieStore,
    (name, value, options) => {
      pendingCookies.push({ name, value, options });
    },
    undefined,
    origin,
  );

  try {
    console.log("[Southleft Callback] Calling auth()...");
    await auth(provider, {
      serverUrl: new URL(SOUTHLEFT_MCP_URL),
      authorizationCode: code,
      scope: "file_content:read,library_content:read,file_variables:read",
    });
    console.log("[Southleft Callback] Auth successful, preparing response...");

    // Extract access token from pending cookies
    let accessToken: string | undefined;
    for (const c of pendingCookies) {
      if (c.name === 'southleft_mcp_tokens' && c.value) {
        try {
          const tokens = JSON.parse(c.value as string);
          accessToken = tokens.access_token || tokens.accessToken;
          console.log("[Southleft Callback] Token payload keys:", Object.keys(tokens), "| refresh_token present:", !!tokens.refresh_token, "| expires_in:", tokens.expires_in);
        } catch (e) {
          console.error("[Southleft Callback] Error parsing tokens:", e);
        }
      }
    }

    // Self-contained success HTML — no redirect to auth-guarded pages
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Figma Console — Connected</title>
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d0d0d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff}.card{text-align:center;padding:48px 40px;background:#161616;border:1px solid rgba(255,255,255,.08);border-radius:16px;max-width:360px;width:100%}.icon{width:56px;height:56px;border-radius:50%;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.3);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:24px}h1{font-size:20px;font-weight:600;margin-bottom:8px}.subtitle{font-size:14px;color:rgba(255,255,255,.5);margin-bottom:24px;line-height:1.5}.close-hint{display:none;font-size:13px;color:rgba(255,255,255,.3);background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px 16px}</style></head>
<body><div class="card"><div class="icon">✓</div><h1>Connected!</h1><p class="subtitle">Figma Console is now connected.<br>Returning to the plugin…</p><p class="close-hint" id="close-hint">Authentication complete — you can close this tab.</p></div>
<script>
var token = ${JSON.stringify(accessToken ?? null)};
if(token){localStorage.setItem('southleft_access_token',token);}
if(window.opener){try{window.opener.postMessage({type:'southleft-oauth-complete',accessToken:token},'*');}catch(e){}}
window.close();
setTimeout(function(){document.getElementById('close-hint').style.display='block';},200);
</script></body></html>`;

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

    writeOAuthResult(session, {
      type: 'southleft-mcp-auth',
      success: false,
    });

    // Self-contained error HTML — no redirect to auth-guarded pages
    const errorHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Figma Console — Error</title>
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d0d0d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff}.card{text-align:center;padding:48px 40px;background:#161616;border:1px solid rgba(255,255,255,.08);border-radius:16px;max-width:360px;width:100%}.icon{width:56px;height:56px;border-radius:50%;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:24px}h1{font-size:20px;font-weight:600;margin-bottom:8px}.subtitle{font-size:14px;color:rgba(255,255,255,.5);line-height:1.5}</style></head>
<body><div class="card"><div class="icon">✗</div><h1>Connection failed</h1><p class="subtitle">Figma Console authentication failed.<br>Please close this window and try again.</p></div>
<script>
if(window.opener){try{window.opener.postMessage({type:'southleft-oauth-complete',error:true},'*');}catch(e){}}
setTimeout(function(){window.close();},3000);
</script></body></html>`;

    return new NextResponse(errorHtml, {
      headers: { "Content-Type": "text/html" },
    });
  }
}
