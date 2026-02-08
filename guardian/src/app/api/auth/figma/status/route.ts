import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const token = req.cookies.get("figma_access_token")?.value;
  return NextResponse.json({ connected: !!token });
}

export async function DELETE(req: NextRequest) {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("figma_access_token");
  response.cookies.delete("figma_refresh_token");
  return response;
}
