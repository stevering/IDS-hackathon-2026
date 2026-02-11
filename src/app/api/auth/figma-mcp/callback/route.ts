import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@ai-sdk/mcp";
import {
  createFigmaMcpOAuthProvider,
  COOKIE_STATE,
  COOKIE_CODE_VERIFIER,
  COOKIE_CLIENT_INFO,
  COOKIE_AUTH_TOKEN,
  getBaseUrl,
} from "@/lib/figma-mcp-oauth";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const savedState = cookieStore.get(COOKIE_STATE)?.value;

  if (!savedState || savedState !== state) {
    const allCookies = cookieStore.getAll().map(c => c.name).join(", ");
    console.error("[Figma MCP OAuth Callback] State mismatch:", { 
      savedState, 
      state, 
      host: request.headers.get("host"),
      cookies: allCookies 
    });
    return NextResponse.json({ 
      error: "Invalid state", 
      details: { savedState: savedState || "missing", receivedState: state || "missing" } 
    }, { status: 400 });
  }

  const pendingCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

  const provider = createFigmaMcpOAuthProvider(
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

    const baseUrl = getBaseUrl();
    const response = NextResponse.redirect(new URL("/", baseUrl));

    for (const c of pendingCookies) {
      response.cookies.set(c.name, c.value, c.options as Parameters<typeof response.cookies.set>[2]);
    }

    response.cookies.delete(COOKIE_STATE);
    response.cookies.delete(COOKIE_CODE_VERIFIER);
    response.cookies.delete(COOKIE_AUTH_TOKEN);

    return response;
  } catch (error) {
    console.error("[Figma MCP OAuth Callback] Error:", error);
    const baseUrl = getBaseUrl();
    return NextResponse.redirect(new URL("/?error=figma_mcp_auth_failed", baseUrl));
  }
}
