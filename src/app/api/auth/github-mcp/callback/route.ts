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

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const savedState = cookieStore.get(GITHUB_COOKIE_STATE)?.value;

  if (!savedState || savedState !== state) {
    console.error("[GitHub MCP OAuth Callback] State mismatch:", {
      savedState,
      state,
      host: request.headers.get("host"),
    });
    return NextResponse.json({
      error: "Invalid state",
      details: { savedState: savedState || "missing", receivedState: state || "missing" },
    }, { status: 400 });
  }

  const pendingCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

  const provider = createGithubMcpOAuthProvider(
    cookieStore,
    (name, value, options) => {
      pendingCookies.push({ name, value, options });
    },
  );

  try {
    await auth(provider, {
      serverUrl: new URL(GITHUB_MCP_URL),
      authorizationCode: code,
      scope: "repo:read,code:read",
    });

    const baseUrl = getBaseUrl();
    const response = NextResponse.redirect(new URL("/", baseUrl));

    for (const c of pendingCookies) {
      response.cookies.set(c.name, c.value, c.options as Parameters<typeof response.cookies.set>[2]);
    }

    response.cookies.delete(GITHUB_COOKIE_STATE);
    response.cookies.delete(GITHUB_COOKIE_CODE_VERIFIER);

    return response;
  } catch (error) {
    console.error("[GitHub MCP OAuth Callback] Error:", error);
    const baseUrl = getBaseUrl();
    return NextResponse.redirect(new URL("/?error=github_mcp_auth_failed", baseUrl));
  }
}