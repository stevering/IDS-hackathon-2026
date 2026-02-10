import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === 'development';

const nextConfig: NextConfig = {
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
