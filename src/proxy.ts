import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const MCP_CODE_URL = "http://127.0.0.1:64342";
const PROXY_PREFIX = "/proxy-local/code";

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Désactiver le middleware en production
  if (process.env.NODE_ENV === "production") {
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
                headers: { Accept: "text/event-stream" },
              });

              if (!response.body) {
                controller.close();
                return;
              }

              const reader = response.body.getReader();
              
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                // Décoder le chunk
                const text = decoder.decode(value, { stream: true });
                
                // Réécrire les URLs relatives dans le flux SSE
                // Remplacer toute URL relative "/xxx" par "/proxy-local/code/xxx"
                // Cela capture /message, /notifications, etc.
                const modifiedText = text.replace(
                  /data:\s*(\/[^\s\?]+)(\?|\s|$)/g,
                  `data: ${PROXY_PREFIX}$1$2`
                );
                
                // Réencoder et envoyer
                controller.enqueue(encoder.encode(modifiedText));
              }
              
              controller.close();
            } catch (e) {
              console.error("[Proxy Middleware] SSE error:", e);
              controller.error(e);
            }
          },
        });

        return new NextResponse(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      // Pour les requêtes POST/GET sur message (et autres)
      const body = request.method !== "GET" && request.method !== "HEAD"
        ? await request.arrayBuffer()
        : undefined;

      const response = await fetch(targetUrl, {
        method: request.method,
        headers: {
          "Content-Type": request.headers.get("Content-Type") || "application/json",
          Accept: request.headers.get("Accept") || "*/*",
        },
        body,
      });

      const responseData = await response.arrayBuffer();

      return new NextResponse(responseData, {
        status: response.status,
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "application/json",
        },
      });

    } catch (error) {
      console.error("[Proxy Middleware] Error:", error);
      return NextResponse.json(
        { error: "Proxy error", details: String(error) },
        { status: 502 }
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
