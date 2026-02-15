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

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const baseUrl = getBaseUrl();

  // Enforce canonical domain
  const canonicalUrl = new URL(baseUrl);
  const currentHost = request.headers.get("host");
  if (currentHost && currentHost !== canonicalUrl.host) {
    const targetUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, baseUrl);
    if (request.url !== targetUrl.toString()) {
      return NextResponse.redirect(targetUrl);
    }
  }

  const state = crypto.randomBytes(16).toString("hex");
  const pendingCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

  const provider = createGithubMcpOAuthProvider(
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

    return NextResponse.redirect(new URL("/", baseUrl));
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
      response.cookies.set(GITHUB_COOKIE_STATE, redirectState, {
        httpOnly: true,
        secure: isSecure,
        sameSite: "lax",
        path: "/",
        maxAge: 600,
      });

      return response;
    }

    console.error("[GitHub MCP OAuth] Auth error:", error);
    console.error('[GitHub MCP DEBUG] Full error:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "OAuth initialization failed" }, { status: 500 });
  }
}