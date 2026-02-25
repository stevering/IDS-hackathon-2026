import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

const COOKIE_AUTH_TOKEN = "mcp_auth_token";

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const { token } = await request.json();
  
  if (!token) {
    return NextResponse.json({ error: "Token required" }, { status: 400 });
  }

  // Set HTTP-only cookie with the token
  cookieStore.set(COOKIE_AUTH_TOKEN, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 5, // 5 minutes, enough for OAuth flow
    path: "/",
  });

  return NextResponse.json({ success: true });
}
