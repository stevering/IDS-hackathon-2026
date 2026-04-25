import { NextResponse } from "next/server";

// Public health check — called cross-origin by the Electron overlay (different origin
// than the webapp in preview/prod) and by anything that wants to verify the cloud is up.
// No sensitive data is returned, so a wildcard CORS header is safe.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

export async function GET() {
  return NextResponse.json(
    { status: "ok", service: "guardian-cloud" },
    { headers: CORS_HEADERS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
