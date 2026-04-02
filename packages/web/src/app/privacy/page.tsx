import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — Guardian",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-2xl">
        <div className="mb-10 text-center">
          <img src="/guardian-logo.svg" alt="Guardian" className="h-10 mx-auto mb-2" />
          <h1 className="text-xl font-semibold">Privacy Policy</h1>
          <p className="text-sm text-white/50 mt-1">
            Guardian Platform — Private Beta
          </p>
          <p className="text-xs text-white/30 mt-1">
            Last updated: April 2026
          </p>
        </div>

        <div className="space-y-8 text-sm text-white/70 leading-relaxed">
          {/* 1 */}
          <section>
            <h2 className="text-white font-medium mb-2">1. Data Controller</h2>
            <p>
              The Guardian platform (&quot;Platform&quot;) is operated by its development team
              during the private beta phase. For any question regarding your personal data,
              contact us at:{" "}
              <a href="mailto:privacy@guardian.figdesys.com" className="text-white/80 underline hover:text-white transition-colors">
                privacy@guardian.figdesys.com
              </a>
            </p>
          </section>

          {/* 2 */}
          <section>
            <h2 className="text-white font-medium mb-2">2. Data We Collect</h2>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-white/50">
                  <th className="pb-2 pr-4 font-medium">Category</th>
                  <th className="pb-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="text-white/60">
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4 align-top">Account</td>
                  <td className="py-2">Email, first name, last name, work role, hashed password</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4 align-top">Preferences</td>
                  <td className="py-2">Default AI model, approval mode, developer settings</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4 align-top">Conversations</td>
                  <td className="py-2">Messages exchanged with the AI assistant (text, tool calls, results)</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4 align-top">Figma data</td>
                  <td className="py-2">Selected node properties, page names, file identifiers, screenshots sent via the plugin</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4 align-top">API keys (BYOK)</td>
                  <td className="py-2">Encrypted in Supabase Vault (pgsodium). Never returned to the client. Provider name stored in clear.</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4 align-top">Usage</td>
                  <td className="py-2">Token counts and estimated cost per AI request</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4 align-top">Audit</td>
                  <td className="py-2">IP address and user-agent at CGU acceptance</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4 align-top">OAuth tokens</td>
                  <td className="py-2">Figma, GitHub, and Figma Console (Southleft) access/refresh tokens, encrypted in Vault</td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* 3 */}
          <section>
            <h2 className="text-white font-medium mb-2">3. Purposes and Legal Basis</h2>
            <ul className="list-disc list-inside space-y-1 text-white/60 text-xs">
              <li><span className="text-white/70">Contract execution</span> — providing the Platform services (conversations, orchestrations, Figma integration)</li>
              <li><span className="text-white/70">Legitimate interest</span> — anonymous performance analytics (Vercel Analytics, Speed Insights), security monitoring, abuse prevention, service improvement</li>
            </ul>
          </section>

          {/* 4 */}
          <section>
            <h2 className="text-white font-medium mb-2">4. Hosting and Subprocessors</h2>
            <p className="text-xs text-white/60 mb-3">
              All Platform infrastructure is hosted in the <strong className="text-white/70">European Union</strong>.
              The only exception is when conversation data is sent to AI model providers
              for response generation (see Section 5).
            </p>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-white/50">
                  <th className="pb-2 pr-4 font-medium">Service</th>
                  <th className="pb-2 pr-4 font-medium">Provider</th>
                  <th className="pb-2 pr-4 font-medium">Location</th>
                  <th className="pb-2 font-medium">Purpose</th>
                </tr>
              </thead>
              <tbody className="text-white/60">
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Database &amp; Auth</td>
                  <td className="py-2 pr-4">Supabase</td>
                  <td className="py-2 pr-4">Paris, France</td>
                  <td className="py-2">User accounts, conversations, encrypted secrets</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Web hosting</td>
                  <td className="py-2 pr-4">Vercel</td>
                  <td className="py-2 pr-4">Paris, France</td>
                  <td className="py-2">Application, serverless functions</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Orchestration</td>
                  <td className="py-2 pr-4">Temporal Cloud</td>
                  <td className="py-2 pr-4">Frankfurt, Germany</td>
                  <td className="py-2">Multi-agent workflow coordination (metadata only, not conversation content)</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Worker</td>
                  <td className="py-2 pr-4">Railway</td>
                  <td className="py-2 pr-4">Amsterdam, Netherlands</td>
                  <td className="py-2">Background task processing</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Figma Console</td>
                  <td className="py-2 pr-4">Southleft</td>
                  <td className="py-2 pr-4">—</td>
                  <td className="py-2">Figma design tool execution (optional, user-initiated OAuth)</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Analytics</td>
                  <td className="py-2 pr-4">Vercel</td>
                  <td className="py-2 pr-4">—</td>
                  <td className="py-2">Anonymous page view and performance metrics</td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* 5 */}
          <section>
            <h2 className="text-white font-medium mb-2">5. AI Providers and Data Transit</h2>
            <p className="text-xs text-white/60">
              Conversation data is sent to third-party AI model providers to generate responses.
              This is the <strong className="text-white/70">only scenario where your data may leave the EU</strong>.
            </p>
            <ul className="list-disc list-inside space-y-2 text-white/60 text-xs mt-3">
              <li>
                <span className="text-white/70">Included free tier</span> — conversations are routed through
                Vercel AI Gateway (United States) to the selected AI provider. Transfers are
                covered by Vercel&apos;s Standard Contractual Clauses (SCCs).
              </li>
              <li>
                <span className="text-white/70">BYOK with a Vercel AI Gateway key</span> — same routing as above,
                using your own gateway key. Data transits through the US.
              </li>
              <li>
                <span className="text-white/70">BYOK with a direct provider key</span> (OpenAI, Anthropic, Google, etc.)
                — conversations are sent <strong className="text-white/70">directly to the provider</strong> without
                passing through any intermediary. You have full control over which provider processes your
                data and are responsible for the terms, costs, and data residency of the provider you choose.
              </li>
            </ul>
          </section>

          {/* 6 */}
          <section>
            <h2 className="text-white font-medium mb-2">6. External Integrations</h2>
            <p className="text-xs text-white/60 mb-2">
              The Platform supports optional connections to external services via OAuth 2.0.
              These connections are user-initiated and can be revoked at any time.
            </p>
            <ul className="list-disc list-inside space-y-1 text-white/60 text-xs">
              <li><span className="text-white/70">Figma</span> — read access to your design files and metadata</li>
              <li><span className="text-white/70">GitHub</span> — repository access for code-related features</li>
              <li><span className="text-white/70">Figma Console (Southleft)</span> — design tool execution capabilities</li>
            </ul>
            <p className="text-xs text-white/60 mt-2">
              The Platform also exposes an MCP (Model Context Protocol) server that external
              AI tools (e.g., IDE extensions) can connect to using OAuth 2.0 Bearer tokens.
              These tools access the same data as the Platform UI, scoped to your account.
            </p>
          </section>

          {/* 7 */}
          <section>
            <h2 className="text-white font-medium mb-2">7. Cookies and Analytics</h2>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-white/50">
                  <th className="pb-2 pr-4 font-medium">Cookie / Service</th>
                  <th className="pb-2 pr-4 font-medium">Type</th>
                  <th className="pb-2 font-medium">Purpose</th>
                </tr>
              </thead>
              <tbody className="text-white/60">
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Supabase session</td>
                  <td className="py-2 pr-4">Essential</td>
                  <td className="py-2">Authentication — required for the Platform to function</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">OAuth state/PKCE</td>
                  <td className="py-2 pr-4">Essential</td>
                  <td className="py-2">Security tokens for OAuth flows (Figma, GitHub, Figma Console)</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Vercel Analytics</td>
                  <td className="py-2 pr-4">Legitimate interest</td>
                  <td className="py-2">Anonymous, cookieless page view counts</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Vercel Speed Insights</td>
                  <td className="py-2 pr-4">Legitimate interest</td>
                  <td className="py-2">Anonymous Core Web Vitals performance metrics</td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-white/40 mt-2">
              Vercel Analytics and Speed Insights collect anonymous, aggregated data with no
              personal identifiers. They do not use tracking cookies and do not build user profiles.
            </p>
          </section>

          {/* 8 */}
          <section>
            <h2 className="text-white font-medium mb-2">8. Data Retention</h2>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-white/50">
                  <th className="pb-2 pr-4 font-medium">Data</th>
                  <th className="pb-2 font-medium">Retention</th>
                </tr>
              </thead>
              <tbody className="text-white/60">
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Account and conversations</td>
                  <td className="py-2">Until account deletion</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Usage logs (token counts)</td>
                  <td className="py-2">48 hours (auto-purged)</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Orchestration events</td>
                  <td className="py-2">7 days after completion (auto-purged)</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">Client registrations</td>
                  <td className="py-2">24 hours without heartbeat (auto-purged)</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="py-2 pr-4">CGU acceptance records</td>
                  <td className="py-2">Indefinite (legal compliance)</td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* 9 */}
          <section>
            <h2 className="text-white font-medium mb-2">9. Your Rights (GDPR)</h2>
            <p className="text-xs text-white/60 mb-2">
              Under the General Data Protection Regulation, you have the right to:
            </p>
            <ul className="list-disc list-inside space-y-1 text-white/60 text-xs">
              <li><span className="text-white/70">Access</span> — obtain a copy of your personal data</li>
              <li><span className="text-white/70">Rectification</span> — correct inaccurate data</li>
              <li><span className="text-white/70">Erasure</span> — request deletion of your data</li>
              <li><span className="text-white/70">Portability</span> — receive your data in a structured format</li>
              <li><span className="text-white/70">Object</span> — object to processing based on legitimate interest</li>
              <li><span className="text-white/70">Withdraw consent</span> — at any time for consent-based processing</li>
            </ul>
            <p className="text-xs text-white/60 mt-2">
              To exercise these rights, contact{" "}
              <a href="mailto:privacy@guardian.figdesys.com" className="text-white/80 underline hover:text-white transition-colors">
                privacy@guardian.figdesys.com
              </a>.
              You also have the right to lodge a complaint with the French data protection authority (CNIL).
            </p>
          </section>

          {/* 10 */}
          <section>
            <h2 className="text-white font-medium mb-2">10. Security</h2>
            <ul className="list-disc list-inside space-y-1 text-white/60 text-xs">
              <li>API keys and OAuth tokens encrypted at rest (Supabase Vault / pgsodium)</li>
              <li>Row-Level Security (RLS) on all user tables — users can only access their own data</li>
              <li>TLS encryption for all data in transit (HTTPS, gRPC+TLS)</li>
              <li>OAuth 2.0 with PKCE for all third-party integrations</li>
              <li>Invite-only access during private beta</li>
            </ul>
          </section>

          {/* 11 */}
          <section>
            <h2 className="text-white font-medium mb-2">11. Governing Law</h2>
            <p className="text-xs text-white/60">
              This Privacy Policy is governed by the laws of France. Any dispute shall be submitted
              to the exclusive jurisdiction of the courts of Paris.
            </p>
          </section>
        </div>

        <div className="mt-12 flex justify-center gap-4 text-sm text-white/40">
          <Link href="/login" className="hover:text-white/70 transition-colors">
            Sign in
          </Link>
          <span>·</span>
          <Link href="/account" className="hover:text-white/70 transition-colors">
            Account
          </Link>
        </div>
      </div>
    </div>
  );
}
