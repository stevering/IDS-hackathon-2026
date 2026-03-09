"use client";

import { Suspense, useEffect, useState, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Trusted redirect URI patterns — block everything else
const ALLOWED_REDIRECT_PATTERNS = [
  /^http:\/\/localhost(:\d+)?\//, // Local dev
  /^http:\/\/127\.0\.0\.1(:\d+)?\//, // Local dev
  /^https:\/\/.*\.guardian\.figdesys\.com\//, // Production
  /^https:\/\/guardian\.figdesys\.com\//, // Production
];

type ConsentDetails = {
  authorization_id: string;
  redirect_uri: string;
  client: {
    id: string;
    name: string;
    uri: string;
    logo_uri: string;
  };
  scope: string;
};

type ConsentState =
  | { step: "loading" }
  | { step: "login" }
  | { step: "consent"; details: ConsentDetails }
  | { step: "blocked"; reason: string }
  | { step: "error"; message: string }
  | { step: "done" };

export default function OAuthConsentPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-white/50">Loading…</p>
      </div>
    }>
      <OAuthConsentContent />
    </Suspense>
  );
}

function OAuthConsentContent() {
  const searchParams = useSearchParams();
  const authorizationId = searchParams.get("authorization_id");
  const [state, setState] = useState<ConsentState>({ step: "loading" });
  const [processing, setProcessing] = useState(false);
  const supabaseRef = useRef(createClient());

  useEffect(() => {
    if (!authorizationId) {
      setState({ step: "error", message: "Missing authorization_id parameter." });
      return;
    }

    async function loadDetails() {
      const supabase = supabaseRef.current;

      // Check if user is logged in
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setState({ step: "login" });
        return;
      }

      try {
        const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId!);

        if (error) {
          setState({ step: "error", message: error.message });
          return;
        }

        if (!data) {
          setState({ step: "error", message: "No authorization details returned." });
          return;
        }

        // If consent was already given, redirect immediately
        if ("redirect_url" in data) {
          setState({ step: "done" });
          window.location.href = (data as { redirect_url: string }).redirect_url;
          return;
        }

        const details = data as ConsentDetails;

        // Validate redirect URI against allowlist
        if (!ALLOWED_REDIRECT_PATTERNS.some((p) => p.test(details.redirect_uri))) {
          setState({
            step: "blocked",
            reason: `Untrusted redirect URI: ${details.redirect_uri}`,
          });
          return;
        }

        setState({ step: "consent", details });
      } catch (err) {
        setState({
          step: "error",
          message: err instanceof Error ? err.message : "Failed to load authorization details.",
        });
      }
    }

    loadDetails();
  }, [authorizationId]);

  async function handleApprove() {
    if (state.step !== "consent") return;
    setProcessing(true);
    try {
      const { data, error } = await supabaseRef.current.auth.oauth.approveAuthorization(
        state.details.authorization_id
      );
      if (error) {
        setState({ step: "error", message: error.message });
        return;
      }
      setState({ step: "done" });
      window.location.href = data.redirect_url;
    } catch (err) {
      setState({
        step: "error",
        message: err instanceof Error ? err.message : "Approval failed.",
      });
    }
  }

  async function handleDeny() {
    if (state.step !== "consent") return;
    setProcessing(true);
    try {
      const { data, error } = await supabaseRef.current.auth.oauth.denyAuthorization(
        state.details.authorization_id
      );
      if (error) {
        setState({ step: "error", message: error.message });
        return;
      }
      setState({ step: "done" });
      window.location.href = data.redirect_url;
    } catch (err) {
      setState({
        step: "error",
        message: err instanceof Error ? err.message : "Denial failed.",
      });
    }
  }

  function handleLogin() {
    // Redirect to login page, preserving the authorization_id for after login
    const returnUrl = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId ?? "")}`;
    window.location.href = `/login?returnTo=${encodeURIComponent(returnUrl)}`;
  }

  const scopes = state.step === "consent" ? state.details.scope.split(" ").filter(Boolean) : [];

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="text-3xl mb-2">🛡</div>
          <h1 className="text-xl font-semibold">Guardian</h1>
        </div>

        {state.step === "loading" && (
          <p className="text-center text-sm text-white/50">Loading authorization details…</p>
        )}

        {state.step === "login" && (
          <div className="text-center">
            <p className="text-sm text-white/60 mb-4">
              You need to sign in to authorize this application.
            </p>
            <button
              onClick={handleLogin}
              className="w-full py-2.5 rounded-lg bg-white text-black text-sm font-medium transition-opacity"
            >
              Sign in
            </button>
          </div>
        )}

        {state.step === "consent" && (
          <div className="rounded-xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-base font-medium mb-1">
              {state.details.client.name || state.details.client.id}
            </h2>
            <p className="text-sm text-white/50 mb-4">wants to access your Guardian account</p>

            {scopes.length > 0 && (
              <div className="mb-4">
                <p className="text-xs text-white/40 mb-2">This will allow the application to:</p>
                <ul className="text-sm text-white/70 space-y-1">
                  {scopes.map((scope) => (
                    <li key={scope} className="flex items-center gap-2">
                      <span className="text-white/30">•</span>
                      {scopeLabel(scope)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="text-xs text-white/30 mb-5 break-all">
              Client ID: {state.details.client.id}
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleDeny}
                disabled={processing}
                className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-white/60 hover:text-white transition-colors disabled:opacity-40"
              >
                Deny
              </button>
              <button
                onClick={handleApprove}
                disabled={processing}
                className="flex-1 py-2.5 rounded-lg bg-white text-black text-sm font-medium disabled:opacity-40 transition-opacity"
              >
                {processing ? "Authorizing…" : "Authorize"}
              </button>
            </div>
          </div>
        )}

        {state.step === "blocked" && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-6 text-center">
            <p className="text-sm text-red-400 font-medium mb-2">Authorization blocked</p>
            <p className="text-xs text-red-400/60">{state.reason}</p>
          </div>
        )}

        {state.step === "error" && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-6 text-center">
            <p className="text-sm text-red-400 font-medium mb-2">Something went wrong</p>
            <p className="text-xs text-red-400/60">{state.message}</p>
          </div>
        )}

        {state.step === "done" && (
          <p className="text-center text-sm text-white/50">Redirecting…</p>
        )}
      </div>
    </div>
  );
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case "openid": return "Verify your identity";
    case "email": return "View your email address";
    case "profile": return "View your profile information";
    case "phone": return "View your phone number";
    default: return scope;
  }
}
