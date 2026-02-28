import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROXY_PREFIX = "/proxy-local/code";

// Figma MCP auth routes that should not be protected by X-Auth-Token
// because they are accessed via browser redirect
const PUBLIC_AUTH_ROUTES = [
  "/api/auth/figma-mcp",
  "/api/auth/figma-mcp/callback",
  "/api/auth/figma-mcp/register",
  "/api/auth/figma-mcp/status",
  "/api/auth/southleft-mcp",
  "/api/auth/southleft-mcp/callback",
  "/api/auth/southleft-mcp/status",
  "/api/auth/github-mcp",
  "/api/auth/github-mcp/callback",
  "/api/auth/github-mcp/status",
  "/api/auth/set-token",
  "/api/set-oauth-result", // Allow POST without token for callback
  "/api/guardian-auth",    // Better Auth routes (login, signup, session)
  "/api/guardian/status",  // Health check for the overlay (no auth token)
];

function getMcpCodeUrl(request: NextRequest): string | undefined {
  const headerUrl = request.headers.get("X-MCP-Code-URL");
  const envUrl = process.env.NEXT_PUBLIC_LOCAL_MCP_CODE_URL;

  console.log("[getMcpCodeUrl] headerUrl:", headerUrl);
  console.log("[getMcpCodeUrl] envUrl:", envUrl);
  console.log("[getMcpCodeUrl] headerUrl truthy?", !!headerUrl);

  const url = headerUrl || envUrl;
  if (!url) return undefined;
  // Return the full URL (with path) without the trailing slash
  return url.replace(/\/$/, '');
}

// Pages accessible without being logged in
const PUBLIC_PAGES = ["/login", "/signup"];

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const MCP_CODE_URL = getMcpCodeUrl(request);

  // ── Auth guard: protected pages ──────────────────────────────────────────
  // Applies in dev AND prod, before any other logic.
  const isApiOrStatic =
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon");

  if (!isApiOrStatic && !PUBLIC_PAGES.some((p) => pathname.startsWith(p))) {
    const sessionToken = request.cookies.get("better-auth.session_token");
    if (!sessionToken) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  // Disable the rest of the middleware in production (proxy dev-only)
  // And don't apply the X-Auth-Token check to pages (only to /api/ routes)
  if (process.env.NODE_ENV === "production" || !pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Skip auth check for public auth routes (browser redirects don't have custom headers)
  const isPublicAuthRoute = PUBLIC_AUTH_ROUTES.some(route =>
    pathname === route || pathname.startsWith(`${route}/`)
  );
  
  if (isPublicAuthRoute) {
    console.log("[Middleware] Skipping X-Auth-Token check for public auth route:", pathname);
    return NextResponse.next();
  }

  // Verify the NEXT_PUBLIC_MCP_TUNNEL_SECRET for all requests
  const expectedSecret = process.env.NEXT_PUBLIC_MCP_TUNNEL_SECRET;
  const providedSecret = request.headers.get("X-Auth-Token");

  console.log("[Middleware] X-Auth-Token check");
  if (!expectedSecret) {
    console.error("[Middleware] NEXT_PUBLIC_MCP_TUNNEL_SECRET not configured");
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }

  if (providedSecret !== expectedSecret) {
    console.error("[Middleware] X-Auth-Token invalid or missing");
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Proxy for MCP Code
  if (pathname.startsWith(`${PROXY_PREFIX}/`)) {
    if (!MCP_CODE_URL) {
      console.error("[Proxy Middleware] MCP_CODE_URL not configured");
      return NextResponse.json(
        { error: "MCP Code URL not configured" },
        { status: 500 }
      );
    }

    const targetPath = pathname.replace(`${PROXY_PREFIX}/`, "");

    // Parse the base URL to extract origin and pathname
    const baseUrlObj = new URL(MCP_CODE_URL);
    const baseOrigin = baseUrlObj.origin;
    const basePathname = baseUrlObj.pathname.replace(/\/$/, ''); // Remove trailing slash

    // Build the target URL:
    // - If the configured URL ends with /mcp or /sse, append the targetPath
    // - Otherwise (custom URL like /mcp3), forward to the base URL without appending a path
    const isStandardMcpPath = basePathname.endsWith('/mcp') || basePathname.endsWith('/sse');
    const baseLastSegment = basePathname.split('/').pop();
    const shouldAppendTargetPath = isStandardMcpPath && targetPath && targetPath !== baseLastSegment;

    const targetUrl = shouldAppendTargetPath
      ? `${baseOrigin}${basePathname}/${targetPath}${search}`
      : `${baseOrigin}${basePathname}${search}`;

    console.log(`[Proxy Middleware] ${request.method} ${targetPath || '(root)'} -> ${targetUrl}`);

    try {
      // For SSE (GET on sse)
      if (targetPath === "sse" && request.method === "GET") {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        
        const stream = new ReadableStream({
          async start(controller) {
            try {
              const response = await fetch(targetUrl, {
                method: "GET",
                headers: {
                  Accept: "text/event-stream",
                },
              });

              if (!response.body) {
                controller.close();
                return;
              }

              const reader = response.body.getReader();
              
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                // Decode and modify content to remap URLs
                const text = decoder.decode(value, { stream: true });
                // Replace any relative URL "/xxx" with "/proxy-local/code/xxx"
                const modifiedText = text.replace(
                  /data:\s(\/[^\s\n\r]*)/g,
                  `data: ${PROXY_PREFIX}$1`
                );
                
                controller.enqueue(encoder.encode(modifiedText));
              }
              
              controller.close();
            } catch (e) {
              console.error("[Proxy Middleware] SSE error:", e);
              controller.error(e);
            }
          }
        });

        return new NextResponse(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }

      // For other requests (messages, etc.)
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: {
          "Content-Type": request.headers.get("Content-Type") || "application/json",
          "Accept": request.headers.get("Accept") || "application/json, text/event-stream",
        },
        body: request.method !== "GET" && request.method !== "HEAD"
          ? await request.text()
          : undefined,
      });

      const data = await response.text();
      
      return new NextResponse(data, {
        status: response.status,
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "application/json",
        },
      });
    } catch (error) {
      console.error("[Proxy Middleware] Error:", error);
      return NextResponse.json(
        { error: "Proxy error", details: String(error) },
        { status: 500 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Application pages (auth guard)
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ]
};