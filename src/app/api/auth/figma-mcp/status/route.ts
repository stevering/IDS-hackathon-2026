import { NextRequest, NextResponse } from "next/server";
import { COOKIE_TOKENS, COOKIE_CLIENT_INFO, COOKIE_CODE_VERIFIER, COOKIE_STATE } from "@/lib/figma-mcp-oauth";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(COOKIE_TOKENS)?.value;
  return NextResponse.json({ connected: !!token });
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(COOKIE_TOKENS);
  response.cookies.delete(COOKIE_CLIENT_INFO);
  response.cookies.delete(COOKIE_CODE_VERIFIER);
  response.cookies.delete(COOKIE_STATE);
  return response;
}
