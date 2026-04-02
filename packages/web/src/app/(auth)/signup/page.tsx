"use client";

import Link from "next/link";
import { LegalFooter } from "@/components/LegalFooter";

export default function SignupPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <div className="mb-8">
          <img src="/guardian-logo.svg" alt="Guardian" className="h-10 mx-auto mb-2" />
          <h1 className="text-xl font-semibold">Guardian</h1>
          <p className="text-sm text-white/50 mt-1">Private Beta</p>
        </div>

        <div className="px-4 py-6 rounded-lg bg-white/[0.03] border border-white/[0.08] mb-6">
          <p className="text-sm text-white/70 leading-relaxed">
            Access to Guardian is currently <strong className="text-white">invite-only</strong>.
          </p>
          <p className="text-xs text-white/40 mt-3 leading-relaxed">
            If you have received an invitation email, click the link in the email to create your account.
            If you believe you should have access, contact your administrator.
          </p>
        </div>

        <p className="text-sm text-white/40">
          Already have an account?{" "}
          <Link href="/login" className="text-white/70 hover:text-white transition-colors">
            Sign in
          </Link>
        </p>
      </div>
      <LegalFooter />
    </div>
  );
}
