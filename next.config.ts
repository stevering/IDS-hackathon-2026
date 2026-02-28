import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === 'development';

const nextConfig: NextConfig = {
    async headers() {
        return [
            {
                source: "/:path*",
                headers: [
                    {
                        key: "Cross-Origin-Opener-Policy",
                        value: "same-origin-allow-popups",
                    },
                ],
            },
        ];
    },
    async rewrites() {
        if (!isDev) {
            return []; // Returns an empty list in production
        }

        return [
            {
                source: '/proxy-local/figma/:path*',
                destination: 'http://127.0.0.1:3845/:path*',
            },
            // Code MCP Proxy handled by src/middleware.ts
        ];
    },
};

export default nextConfig;
