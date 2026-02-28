"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function UserMenu() {
  const { data: session } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!session?.user) return null;

  const { name, email } = session.user;
  const initials = name
    ? name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()
    : email?.[0]?.toUpperCase() ?? "?";

  async function handleSignOut() {
    await authClient.signOut();
    router.push("/login");
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-full pl-1 pr-2 py-1 hover:bg-white/5 transition-colors cursor-pointer"
        title={email ?? ""}
      >
        {/* Avatar */}
        <div className="w-7 h-7 rounded-full bg-violet-600/70 border border-violet-500/40 flex items-center justify-center text-[11px] font-semibold text-white shrink-0">
          {initials}
        </div>
        {/* Chevron */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="currentColor"
          className={`text-white/40 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-52 rounded-xl bg-[#0f0a1e] border border-white/10 shadow-2xl z-50 overflow-hidden">
          {/* User info */}
          <div className="px-3 py-2.5 border-b border-white/5">
            <p className="text-xs font-medium text-white truncate">{name ?? email}</p>
            {name && <p className="text-[11px] text-white/40 truncate mt-0.5">{email}</p>}
          </div>
          {/* Actions */}
          <div className="p-1">
            <button
              onClick={handleSignOut}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer text-left"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Se déconnecter
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
