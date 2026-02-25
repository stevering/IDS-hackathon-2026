import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const clientId = process.env.FIGMA_CLIENT_ID;
  const clientSecret = process.env.FIGMA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "FIGMA_CLIENT_ID or FIGMA_CLIENT_SECRET not configured" }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const savedState = req.cookies.get("figma_oauth_state")?.value;

  if (!code || !state || state !== savedState) {
    return NextResponse.json({ error: "Invalid OAuth callback" }, { status: 400 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://127.0.0.1:3000";
  const isSecure = baseUrl.startsWith("https");
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const tokenRes = await fetch("https://api.figma.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      redirect_uri: `${baseUrl}/api/auth/figma/callback`,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("[Figma OAuth] Token exchange failed:", err);
    return NextResponse.json({ error: "Token exchange failed" }, { status: 500 });
  }

  const data = await tokenRes.json();

  const response = NextResponse.redirect(baseUrl);

  response.cookies.set("figma_access_token", data.access_token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: data.expires_in || 7776000,
    path: "/",
  });

  if (data.refresh_token) {
    response.cookies.set("figma_refresh_token", data.refresh_token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "lax",
      maxAge: 365 * 24 * 3600,
      path: "/",
    });
  }

  response.cookies.delete("figma_oauth_state");

  return response;
}
