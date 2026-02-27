import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@ai-sdk/mcp";
import {
  createSouthleftMcpOAuthProvider,
  SOUTHLEFT_COOKIE_STATE,
  SOUTHLEFT_COOKIE_CODE_VERIFIER,
  SOUTHLEFT_MCP_URL,
} from "@/lib/southleft-mcp-oauth";
import {getBaseUrl} from "@/lib/get-base-url";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const savedState = cookieStore.get(SOUTHLEFT_COOKIE_STATE)?.value;

  if (!savedState || savedState !== state) {
    console.error("[Southleft MCP OAuth Callback] State mismatch:", {
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

  const provider = await createSouthleftMcpOAuthProvider(
    cookieStore,
    (name, value, options) => {
      pendingCookies.push({ name, value, options });
    },
  );

  try {
    await auth(provider, {
      serverUrl: new URL(SOUTHLEFT_MCP_URL),
      authorizationCode: code,
      scope: "file_content:read,library_content:read,file_variables:read",
    });

    const baseUrl = await getBaseUrl();
    const doneUrl = new URL("/auth-callback.html", baseUrl);
    doneUrl.searchParams.set("auth", "success");
    doneUrl.searchParams.set("source", "southleft-mcp");
    const response = NextResponse.redirect(doneUrl);

    for (const c of pendingCookies) {
      response.cookies.set(c.name, c.value, c.options as Parameters<typeof response.cookies.set>[2]);
    }

    response.cookies.delete(SOUTHLEFT_COOKIE_STATE);
    response.cookies.delete(SOUTHLEFT_COOKIE_CODE_VERIFIER);

    return response;
  } catch (error) {
    console.error("[Southleft MCP OAuth Callback] Error:", error);
    const baseUrl = await getBaseUrl();
    const doneUrl = new URL("/auth-callback.html", baseUrl);
    doneUrl.searchParams.set("auth", "failed");
    doneUrl.searchParams.set("source", "southleft-mcp");
    return NextResponse.redirect(doneUrl);
  }
}
