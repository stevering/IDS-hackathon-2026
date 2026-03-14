"use client";

import Link from "next/link";
import { UserMenu } from "./UserMenu";

export function AppHeader() {
  return (
    <header
      className="sticky top-0 left-0 right-0 z-20 flex flex-col"
      style={{
        background: "rgba(10,10,10,0.3)",
        backdropFilter: "blur(6px) saturate(1.3)",
        WebkitBackdropFilter: "blur(6px) saturate(1.3)",
        boxShadow:
          "0 4px 24px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.06) inset",
      }}
    >
      <div className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-white/30">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Link
            href="/"
            className="p-2 rounded-md hover:bg-white/5 transition-colors shrink-0"
            title="Back to chat"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5M5 12l7-7M5 12l7 7" />
            </svg>
          </Link>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold truncate">Guardian</h1>
            <p className="text-xs text-white/65 hidden sm:block">
              [Design ↔ Code] Design System Guardian
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
