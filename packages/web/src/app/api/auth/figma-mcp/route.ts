import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@ai-sdk/mcp";
import crypto from "crypto";
import {
  createFigmaMcpOAuthProvider,
  RedirectError,
  COOKIE_STATE,
  COOKIE_CLIENT_INFO,
  getBaseUrl,
} from "@/lib/figma-mcp-oauth";
import { writeOAuthResult } from "@/lib/oauth-store";

const COOKIE_OAUTH_SESSION = "figma_oauth_session";

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();

  // Enforce canonical domain to avoid cookie loss between localhost and 127.0.0.1
  const baseUrl = await getBaseUrl();
  const canonicalUrl = new URL(baseUrl);
  const currentHost = request.headers.get("host");

  if (currentHost && currentHost !== canonicalUrl.host) {
    const targetUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, baseUrl);
    if (request.url !== targetUrl.toString()) {
      console.log(`[Figma MCP OAuth] Redirecting to canonical host: ${canonicalUrl.host} (current: ${currentHost})`);
      return NextResponse.redirect(targetUrl);
    }
  }

  const session = request.nextUrl.searchParams.get("session") || "shared-dev-session";

  const state = crypto.randomBytes(16).toString("hex");
  const pendingCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

  // Check if we have a dynamically registered client (DCR)
  const dcrClientRaw = cookieStore.get(COOKIE_CLIENT_INFO)?.value;
  let hasDcrClient = false;
  if (dcrClientRaw) {
    try {
      const dcrClient = JSON.parse(dcrClientRaw);
      hasDcrClient = !!dcrClient.client_id && !process.env.FIGMA_CLIENT_ID;
      // If static FIGMA_CLIENT_ID is set, DCR client takes priority only if it's truly from DCR
      if (dcrClient.client_id && dcrClient.client_id !== process.env.FIGMA_CLIENT_ID) {
        hasDcrClient = true;
      }
      console.log("[Figma MCP OAuth] DCR client found:", dcrClient.client_id, "hasDcrClient:", hasDcrClient);
    } catch {
      // ignore
    }
  }

  // Determine mode: "mcp" (native MCP OAuth with mcp:connect) or "standard" (fallback)
  const useMcpMode = hasDcrClient || request.nextUrl.searchParams.get("mode") === "mcp";
  console.log("[Figma MCP OAuth] Mode:", useMcpMode ? "MCP (mcp:connect)" : "Standard (fallback)");

  const provider = await createFigmaMcpOAuthProvider(
    cookieStore,
    (name, value, options) => {
      pendingCookies.push({ name, value, options });
    },
    state,
  );

  try {
    if (useMcpMode) {
      // Native MCP OAuth flow: use mcp.figma.com issuer with mcp:connect scope
      await auth(provider, {
        serverUrl: new URL("https://mcp.figma.com"),
        scope: "mcp:connect",
      });
    } else {
      // Fallback: standard Figma OAuth with regular scopes
      // Override the authorization endpoint to use /oauth instead of /oauth/mcp
      await auth(provider, {
        serverUrl: new URL("https://api.figma.com"),
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
    // Tokens already valid — notify the polling client directly
    writeOAuthResult(session, { type: "figma-mcp-auth", success: true });
    return new NextResponse(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><script>
        if (window.opener) { try { window.opener.postMessage({ type: 'figma-oauth-complete', success: true }, '*'); } catch(e) {} }
        window.close();
      </script></body></html>`,
      { headers: { "Content-Type": "text/html" } }
    );
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
      response.cookies.set(COOKIE_STATE, redirectState, sessionCookieOptions);
      response.cookies.set(COOKIE_OAUTH_SESSION, session, sessionCookieOptions);

      return response;
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[Figma MCP OAuth] Auth error:", msg);
    writeOAuthResult(session, { type: "figma-mcp-auth", success: false });
    return new NextResponse(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
      <p style="font-family:system-ui;color:#f87171;padding:20px">Figma Auth Failed: ${msg.replace(/</g, "&lt;")}</p>
      <script>
        if (window.opener) { try { window.opener.postMessage({ type: 'figma-oauth-error', error: ${JSON.stringify(msg)} }, '*'); } catch(e) {} }
        window.close();
      </script></body></html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }
}
