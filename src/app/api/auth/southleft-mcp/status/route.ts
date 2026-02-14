import { NextRequest, NextResponse } from "next/server";
import {
  SOUTHLEFT_COOKIE_TOKENS,
  SOUTHLEFT_COOKIE_CLIENT_INFO,
  SOUTHLEFT_COOKIE_CODE_VERIFIER,
  SOUTHLEFT_COOKIE_STATE,
} from "@/lib/southleft-mcp-oauth";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SOUTHLEFT_COOKIE_TOKENS)?.value;
  return NextResponse.json({ connected: !!token });
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SOUTHLEFT_COOKIE_TOKENS);
  response.cookies.delete(SOUTHLEFT_COOKIE_CLIENT_INFO);
  response.cookies.delete(SOUTHLEFT_COOKIE_CODE_VERIFIER);
  response.cookies.delete(SOUTHLEFT_COOKIE_STATE);
  return response;
}
