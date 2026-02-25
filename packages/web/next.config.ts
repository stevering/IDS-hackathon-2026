import type { NextConfig } from "next";
import path from "path";

const isDev = process.env.NODE_ENV === 'development';

const nextConfig: NextConfig = {
    turbopack: {
        root: path.resolve(__dirname, '../..'),
    },
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
            return []; // Retourne une liste vide en production
        }

        return [
            {
                source: '/proxy-local/figma/:path*',
                destination: 'http://127.0.0.1:3845/:path*',
            },
            // Proxy Code MCP géré par src/middleware.ts
        ];
    },
};

export default nextConfig;
