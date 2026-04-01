import Link from "next/link";

export function LegalFooter() {
  return (
    <div className="text-center text-xs text-white/30 py-6">
      <Link href="/privacy" className="hover:text-white/50 transition-colors">
        Privacy Policy
      </Link>
      <span className="mx-2">·</span>
      <span>Guardian — Private Beta</span>
    </div>
  );
}
