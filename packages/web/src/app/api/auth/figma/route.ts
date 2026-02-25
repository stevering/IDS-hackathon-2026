import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export async function GET(req: NextRequest) {
  const clientId = process.env.FIGMA_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "FIGMA_CLIENT_ID not configured" }, { status: 500 });
  }

  const state = crypto.randomBytes(16).toString("hex");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://127.0.0.1:3000";
  const isSecure = baseUrl.startsWith("https");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${baseUrl}/api/auth/figma/callback`,
    scope: process.env.FIGMA_OAUTH_SCOPES || "current_user:read,file_content:read,file_metadata:read,file_comments:read,file_dev_resources:read,file_versions:read,library_assets:read,library_content:read,projects:read,team_library_content:read,webhooks:read",
    state,
    response_type: "code",
  });

  const url = `https://www.figma.com/oauth?${params.toString()}`;

  return new NextResponse(null, {
    status: 307,
    headers: {
      Location: url,
      "Set-Cookie": `figma_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${isSecure ? "; Secure" : ""}`,
    },
  });
}
