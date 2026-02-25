import { NextRequest, NextResponse } from "next/server";
import { writeOAuthResult, readOAuthResult } from "@/lib/oauth-store";

export async function POST(request: NextRequest) {
  try {
    const secret = request.headers.get("X-Auth-Token") || "shared-dev-session";
    const body = await request.json();
    if (body.type === "southleft-mcp-auth") {
      writeOAuthResult(secret, body);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
}

export async function GET(request: NextRequest) {
  const secret = request.headers.get("X-Auth-Token");
  if (!secret) {
    return NextResponse.json({ error: "Missing X-Auth-Token" }, { status: 401 });
  }
  const result = readOAuthResult(secret);
  return NextResponse.json(result ?? null);
}
