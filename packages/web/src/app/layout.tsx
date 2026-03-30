import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SpeedInsights } from '@vercel/speed-insights/next';
import { Analytics } from "@vercel/analytics/next";
import { ThemeSync } from "@/components/ThemeSync";
import { MatrixBackground } from "@/components/MatrixBackground";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Guardian",
  description: "[Design ↔ Code] Design System Guardian",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" style={{ background: "#0a0a0a", colorScheme: "dark" }}>
      <head>
        {/* Figma Code-to-Canvas capture script — dev only, remove before production */}
        {process.env.NODE_ENV === "development" && (
          <script src="https://mcp.figma.com/mcp/html-to-design/capture.js" async />
        )}
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        style={{ background: "#0a0a0a" }}
      >
        <ThemeSync />
        {/* Single global animated background — all pages render on top */}
        <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
          <div className="wave-bg-layer wave-bg-1" />
          <div className="wave-bg-layer wave-bg-2" />
          <div className="wave-bg-layer wave-bg-3" />
          <div className="wave-bg-noise" />
          <div className="aurora aurora-1" />
          <div className="aurora aurora-2" />
          <div className="aurora aurora-3" />
          <div className="aurora aurora-4" />
          <div className="aurora aurora-5" />
        </div>
        <MatrixBackground />
        <div className="relative z-10">
          {children}
        </div>
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  );
}
