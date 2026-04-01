"use client";

import { useState } from "react";
import { LegalFooter } from "@/components/LegalFooter";

const CGU_VERSION = "1.0";

const CGU_TEXT = `Terms and Conditions of Use — Guardian Platform (Private Beta)

Effective date: March 2026

1. ACCEPTANCE OF TERMS
By creating an account and using the Guardian platform ("Platform"), you agree to be bound by these Terms and Conditions of Use ("Terms"). If you do not agree, do not use the Platform.

2. PRIVATE BETA ACCESS
Access to the Platform is provided on an invite-only basis during the private beta phase. Your access may be revoked at any time without notice.

3. DATA HANDLING
The Platform processes design system data, including Figma files, code repositories, and related metadata. You acknowledge that:
- You have the right to grant the Platform access to the data you connect.
- The Platform may store and process this data to provide its services.
- You are responsible for ensuring compliance with your organization's data policies.

4. CONFIDENTIALITY
During the private beta, all features, functionality, and communications related to the Platform are confidential. You agree not to share screenshots, documentation, or details about unreleased features without prior written consent.

5. SENSITIVE DATA
You must not upload, transmit, or process any personal data of third parties, financial data, health data, or any data classified as sensitive under GDPR or equivalent regulations, unless explicitly authorized in writing.

6. INTELLECTUAL PROPERTY
All intellectual property rights in the Platform, including its code, design, and documentation, remain the exclusive property of the Platform operator. Your use of the Platform does not transfer any ownership rights.

7. LIMITATION OF LIABILITY
The Platform is provided "as is" during the beta phase. The operator makes no warranties regarding availability, accuracy, or fitness for a particular purpose. In no event shall the operator be liable for any indirect, incidental, or consequential damages.

8. TERMINATION
Either party may terminate access at any time. Upon termination, your right to use the Platform ceases immediately. Data retention policies will be communicated separately.

9. GOVERNING LAW
These Terms are governed by the laws of France. Any disputes shall be submitted to the exclusive jurisdiction of the courts of Paris.

By clicking "I accept", you confirm that you have read, understood, and agree to these Terms.`;

export default function SignupCompletePage() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [workRole, setWorkRole] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [cguAccepted, setCguAccepted] = useState(false);
  const [showCgu, setShowCgu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    if (!cguAccepted) {
      setError("You must accept the Terms and Conditions");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/signup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          workRole,
          password,
          cguVersion: CGU_VERSION,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        window.location.href = "/";
      } else {
        setError(data.error ?? "Something went wrong");
        setLoading(false);
      }
    } catch {
      setError("Network error");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-3xl mb-2">🛡</div>
          <h1 className="text-xl font-semibold">Welcome to Guardian</h1>
          <p className="text-sm text-white/50 mt-1">Complete your profile to get started</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="First name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
              className="flex-1 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/30 transition-colors"
            />
            <input
              type="text"
              placeholder="Last name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
              className="flex-1 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/30 transition-colors"
            />
          </div>

          <input
            type="text"
            placeholder="Work role (e.g. Designer, Developer, PM)"
            value={workRole}
            onChange={(e) => setWorkRole(e.target.value)}
            required
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/30 transition-colors"
          />

          <div className="mt-2">
            <p className="text-xs text-white/40 mb-1">Set your password</p>
          </div>

          <input
            type="password"
            placeholder="Password (min. 8 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/30 transition-colors"
          />
          <input
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/30 transition-colors"
          />

          {/* CGU */}
          <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.02]">
            <button
              type="button"
              onClick={() => setShowCgu(!showCgu)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-white/60 hover:text-white/80 transition-colors"
            >
              <span>Terms and Conditions of Use</span>
              <span className="text-xs">{showCgu ? "▲" : "▼"}</span>
            </button>
            {showCgu && (
              <div className="px-4 pb-4 max-h-60 overflow-y-auto">
                <pre className="text-xs text-white/40 whitespace-pre-wrap font-sans leading-relaxed">
                  {CGU_TEXT}
                </pre>
              </div>
            )}
          </div>

          <label className="flex items-start gap-2 px-1 cursor-pointer">
            <input
              type="checkbox"
              checked={cguAccepted}
              onChange={(e) => setCguAccepted(e.target.checked)}
              className="mt-0.5 accent-white"
            />
            <span className="text-xs text-white/50 leading-relaxed">
              I have read and accept the{" "}
              <button
                type="button"
                onClick={() => setShowCgu(true)}
                className="text-white/70 underline hover:text-white transition-colors"
              >
                Terms and Conditions of Use
              </button>
              {" "}(v{CGU_VERSION}) and the{" "}
              <a
                href="/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/70 underline hover:text-white transition-colors"
              >
                Privacy Policy
              </a>
            </span>
          </label>

          {error && (
            <p className="text-red-400 text-xs px-1">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !cguAccepted}
            className="w-full py-2.5 rounded-lg bg-white text-black text-sm font-medium disabled:opacity-40 transition-opacity mt-1"
          >
            {loading ? "Setting up…" : "Complete registration"}
          </button>
        </form>
      </div>
      <LegalFooter />
    </div>
  );
}
