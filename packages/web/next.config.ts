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
                    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
                    // Prevents MIME sniffing
                    { key: "X-Content-Type-Options", value: "nosniff" },
                    // Limits information sent in the Referer
                    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
                    // Disables unused features
                    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
                    // NB: X-Frame-Options intentionally absent — the app is loaded in
                    // an iframe by the Figma plugin. HSTS handled by Vercel in prod.
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
