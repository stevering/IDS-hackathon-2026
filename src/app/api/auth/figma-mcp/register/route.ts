import { NextRequest, NextResponse } from "next/server";
import { COOKIE_CLIENT_INFO, getBaseUrl, getRedirectUrl } from "@/lib/figma-mcp-oauth";

/**
 * Browser-side DCR proxy.
 * The browser calls this endpoint which forwards the DCR request to Figma.
 * This avoids CORS issues while still making the request from a server context.
 * If this also fails (403), we fall back to standard OAuth.
 */
export async function POST(req: NextRequest) {
  try {
    // Discover OAuth metadata
    const metadataRes = await fetch(
      "https://mcp.figma.com/.well-known/oauth-authorization-server",
      { headers: { "Accept": "application/json" } }
    );
    if (!metadataRes.ok) {
      return NextResponse.json(
        { error: "Failed to fetch OAuth metadata", status: metadataRes.status },
        { status: 502 }
      );
    }
    const metadata = await metadataRes.json();

    if (!metadata.registration_endpoint) {
      return NextResponse.json(
        { error: "No registration endpoint in metadata" },
        { status: 502 }
      );
    }

    // Attempt Dynamic Client Registration
    const clientMetadata = {
      client_name: "DS AI Guardian",
      redirect_uris: [getRedirectUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };

    console.log("[Figma MCP DCR] Attempting registration at:", metadata.registration_endpoint);
    const regRes = await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clientMetadata),
    });

    if (!regRes.ok) {
      const body = await regRes.text();
      console.warn("[Figma MCP DCR] Registration failed:", regRes.status, body);
      return NextResponse.json(
        { error: "DCR failed", status: regRes.status, body },
        { status: regRes.status }
      );
    }

    const clientInfo = await regRes.json();
    console.log("[Figma MCP DCR] Registration successful, client_id:", clientInfo.client_id);

    // Store in cookie for the auth flow
    const baseUrl = getBaseUrl();
    const isSecure = baseUrl.startsWith("https");

    const response = NextResponse.json({ ok: true, client_id: clientInfo.client_id });
    response.cookies.set(COOKIE_CLIENT_INFO, JSON.stringify(clientInfo), {
      httpOnly: true,
      secure: isSecure,
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 24 * 3600,
    });

    return response;
  } catch (error) {
    console.error("[Figma MCP DCR] Error:", error);
    return NextResponse.json(
      { error: "DCR request failed" },
      { status: 500 }
    );
  }
}
