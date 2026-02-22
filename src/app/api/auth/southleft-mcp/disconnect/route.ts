import { NextResponse } from "next/server";
import {
  SOUTHLEFT_COOKIE_TOKENS,
  SOUTHLEFT_COOKIE_CLIENT_INFO,
  SOUTHLEFT_COOKIE_CODE_VERIFIER,
  SOUTHLEFT_COOKIE_STATE,
} from "@/lib/southleft-mcp-oauth";

export async function POST() {
  const response = NextResponse.json({ ok: true });

  const expiredOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };

  response.cookies.set(SOUTHLEFT_COOKIE_TOKENS, "", expiredOptions);
  response.cookies.set(SOUTHLEFT_COOKIE_CLIENT_INFO, "", expiredOptions);
  response.cookies.set(SOUTHLEFT_COOKIE_CODE_VERIFIER, "", expiredOptions);
  response.cookies.set(SOUTHLEFT_COOKIE_STATE, "", expiredOptions);

  return response;
}
