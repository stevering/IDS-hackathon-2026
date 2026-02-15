import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_COOKIE_TOKENS,
  GITHUB_COOKIE_CLIENT_INFO,
  GITHUB_COOKIE_CODE_VERIFIER,
  GITHUB_COOKIE_STATE,
} from "@/lib/github-mcp-oauth";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(GITHUB_COOKIE_TOKENS)?.value;
  return NextResponse.json({ connected: !!token });
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(GITHUB_COOKIE_TOKENS);
  response.cookies.delete(GITHUB_COOKIE_CLIENT_INFO);
  response.cookies.delete(GITHUB_COOKIE_CODE_VERIFIER);
  response.cookies.delete(GITHUB_COOKIE_STATE);
  return response;
}