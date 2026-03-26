"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type PageMode = "loading" | "login" | "invite-expired" | "invite-already-accepted";

/**
 * Decode a JWT payload without verifying the signature.
 * Used to extract the email from an expired invite token.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export default function LoginPage() {
  const isDev = process.env.NODE_ENV === "development";
  const [email, setEmail] = useState(isDev ? "admin@guardian.local" : "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<PageMode>("loading");
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [reinviteInput, setReinviteInput] = useState("");
  const [reinviteStatus, setReinviteStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  useEffect(() => {
    // Check query params first (prod PKCE flow via /auth/callback)
    const searchParams = new URLSearchParams(window.location.search);
    const inviteStatus = searchParams.get("invite_status");
    if (inviteStatus === "accepted") {
      window.history.replaceState(null, "", "/login");
      setMode("invite-already-accepted");
      return;
    }
    if (inviteStatus === "expired") {
      const errorMsg = searchParams.get("error");
      if (errorMsg) setError(decodeURIComponent(errorMsg));
      window.history.replaceState(null, "", "/login");
      setMode("invite-expired");
      return;
    }

    const hash = window.location.hash;
    if (!hash) {
      setMode("login");
      try {
        window.parent.postMessage({ source: "figpal-webapp", type: "AUTH_STATE", authenticated: false }, "*");
      } catch (_) {}
      return;
    }

    const params = new URLSearchParams(hash.substring(1));
    window.history.replaceState(null, "", "/login");

    // Error from Supabase (expired invite, etc.)
    const errorDesc = params.get("error_description");
    if (errorDesc) {
      setError(errorDesc.replace(/\+/g, " "));

      // Try to extract email from the expired access_token in the URL
      // (Supabase doesn't include it in error redirects, but we can check
      // if there's a token from a previous valid session in local storage)
      const accessToken = params.get("access_token");
      if (accessToken) {
        const payload = decodeJwtPayload(accessToken);
        if (payload?.email) {
          checkInviteAndSetMode(payload.email as string);
          return;
        }
      }

      // No token to decode — show expired page with email input
      setMode("invite-expired");
      return;
    }

    // Valid invite token — set session and redirect to signup/complete
    if (params.get("access_token") && params.get("type") === "invite") {
      const supabase = createClient();
      const accessToken = params.get("access_token")!;
      const refreshToken = params.get("refresh_token") ?? "";
      supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(({ data: { session } }) => {
        if (session) {
          window.location.href = "/signup/complete";
        } else {
          setMode("login");
        }
      });
      return;
    }

    setMode("login");
  }, []);

  async function checkInviteAndSetMode(emailToCheck: string) {
    setInviteEmail(emailToCheck);
    try {
      const res = await fetch("/api/signup/check-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailToCheck }),
      });
      const data = await res.json();
      if (data.status === "accepted") {
        setMode("invite-already-accepted");
      } else {
        setMode("invite-expired");
      }
    } catch {
      setMode("invite-expired");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError("Incorrect email or password");
      setLoading(false);
    } else {
      window.location.href = "/";
    }
  }

  async function handleReinvite() {
    const emailToReinvite = inviteEmail || reinviteInput;
    if (!emailToReinvite) return;

    setReinviteStatus("sending");
    try {
      const res = await fetch("/api/signup/request-reinvite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailToReinvite }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.alreadyAccepted) {
          setMode("invite-already-accepted");
        } else {
          setReinviteStatus("sent");
        }
      } else {
        setReinviteStatus("error");
      }
    } catch {
      setReinviteStatus("error");
    }
  }

  if (mode === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-sm text-white/40">Loading…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-3xl mb-2">🛡</div>
          <h1 className="text-xl font-semibold">Guardian</h1>
          <p className="text-sm text-white/50 mt-1">
            {mode === "invite-expired" && "Invitation expired"}
            {mode === "invite-already-accepted" && "Account ready"}
            {mode === "login" && "Sign in to your account"}
          </p>
        </div>

        {/* ── Already accepted ── */}
        {mode === "invite-already-accepted" && (
          <>
            <div className="px-4 py-6 rounded-lg bg-white/[0.03] border border-white/[0.08] mb-6 text-center">
              <p className="text-sm text-white/70">Your account is already set up</p>
              <p className="text-xs text-white/40 mt-2 leading-relaxed">
                You have already accepted your invitation and completed your profile.
                Use the button below to sign in.
              </p>
            </div>
            <button
              onClick={() => { setMode("login"); setError(null); }}
              className="w-full py-2.5 rounded-lg bg-white text-black text-sm font-medium transition-opacity"
            >
              Sign in
            </button>
          </>
        )}

        {/* ── Invite expired ── */}
        {mode === "invite-expired" && (
          <>
            <div className="px-4 py-6 rounded-lg bg-red-400/5 border border-red-400/20 mb-6 text-center">
              <p className="text-sm text-red-400 mb-2">
                {error ?? "This invitation link has expired"}
              </p>
              <p className="text-xs text-white/40 leading-relaxed">
                Invitation links can only be used once and expire after 24 hours.
              </p>
            </div>

            {reinviteStatus === "sent" ? (
              <div className="px-4 py-4 rounded-lg bg-emerald-400/5 border border-emerald-400/20 text-center mb-3">
                <p className="text-sm text-emerald-400">New invitation sent</p>
                <p className="text-xs text-white/40 mt-1">Check your inbox for a new email.</p>
              </div>
            ) : inviteEmail && inviteEmail.includes("@") ? (
              /* Email known from JWT — one-click resend */
              <>
                <p className="text-xs text-white/40 text-center mb-3">
                  Resend invitation to <strong className="text-white/60">{inviteEmail}</strong>
                </p>
                {reinviteStatus === "error" && (
                  <p className="text-red-400 text-xs px-1 mb-2 text-center">Could not send. Please contact your administrator.</p>
                )}
                <button
                  onClick={handleReinvite}
                  disabled={reinviteStatus === "sending"}
                  className="w-full py-2.5 rounded-lg bg-white text-black text-sm font-medium disabled:opacity-40 transition-opacity"
                >
                  {reinviteStatus === "sending" ? "Sending…" : "Request a new invitation"}
                </button>
              </>
            ) : (
              /* Email unknown — ask for it */
              <form onSubmit={(e) => { e.preventDefault(); setInviteEmail(reinviteInput); handleReinvite(); }} className="flex flex-col gap-3">
                <input
                  type="email"
                  placeholder="Enter your email"
                  value={reinviteInput}
                  onChange={(e) => setReinviteInput(e.target.value)}
                  required
                  className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/30 transition-colors"
                />
                {reinviteStatus === "error" && (
                  <p className="text-red-400 text-xs px-1">Could not send. Please contact your administrator.</p>
                )}
                <button
                  type="submit"
                  disabled={reinviteStatus === "sending"}
                  className="w-full py-2.5 rounded-lg bg-white text-black text-sm font-medium disabled:opacity-40 transition-opacity"
                >
                  {reinviteStatus === "sending" ? "Sending…" : "Request a new invitation"}
                </button>
              </form>
            )}

            <button
              onClick={() => { setMode("login"); setError(null); setReinviteStatus("idle"); }}
              className="w-full py-2.5 mt-3 rounded-lg bg-white/5 border border-white/10 text-sm text-white/60 hover:text-white hover:border-white/30 transition-colors"
            >
              Go to sign in
            </button>
          </>
        )}

        {/* ── Normal login ── */}
        {mode === "login" && (
          <>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/30 transition-colors"
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/30 transition-colors"
              />

              {error && (
                <p className="text-red-400 text-xs px-1">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-white text-black text-sm font-medium disabled:opacity-40 transition-opacity mt-1"
              >
                {loading ? "Signing in…" : "Sign in"}
              </button>
            </form>

            <p className="text-center text-sm text-white/40 mt-6">
              Don&apos;t have an account?{" "}
              <Link href="/signup" className="text-white/70 hover:text-white transition-colors">
                Request access
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
