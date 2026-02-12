import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROXY_PREFIX = "/proxy-local/code";

// Routes d'auth Figma MCP qui ne doivent pas être protégées par X-Auth-Token
// car elles sont accédées via redirection navigateur
const PUBLIC_AUTH_ROUTES = [
  "/api/auth/figma-mcp",
  "/api/auth/figma-mcp/callback",
  "/api/auth/figma-mcp/register",
  "/api/auth/figma-mcp/status",
];

function getMcpCodeUrl(request: NextRequest): string | undefined {
  const headerUrl = request.headers.get("X-MCP-Code-URL");
  const envUrl = process.env.NEXT_PUBLIC_LOCAL_MCP_CODE_URL;
  const url = headerUrl || envUrl;
  return url ? new URL(url).origin : undefined;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const MCP_CODE_URL = getMcpCodeUrl(request);

  // Désactiver le middleware en production
  if (process.env.NODE_ENV === "production") {
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

  // Vérification du secret NEXT_PUBLIC_MCP_TUNNEL_SECRET pour toutes les requêtes
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
    console.error("[Middleware] X-Auth-Token invalid or missing", providedSecret, 'expectedSecret', expectedSecret);
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Proxy pour le MCP Code
  if (pathname.startsWith(`${PROXY_PREFIX}/`)) {
    const targetPath = pathname.replace(`${PROXY_PREFIX}/`, "");
    const targetUrl = `${MCP_CODE_URL}/${targetPath}${search}`;

    console.log(`[Proxy Middleware] ${request.method} ${targetPath} -> ${targetUrl}`);

    try {
      // Pour SSE (GET sur sse)
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
                
                // Décoder et modifier le contenu pour remapper les URLs
                const text = decoder.decode(value, { stream: true });
                // Remplacer toute URL relative "/xxx" par "/proxy-local/code/xxx"
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

      // Pour les autres requêtes (messages, etc.)
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
    "/proxy-local/code/:path*",
    "/proxy-local/figma/:path*",
    "/api/:path*",
  ]
};