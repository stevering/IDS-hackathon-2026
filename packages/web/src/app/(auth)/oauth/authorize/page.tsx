import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isRedirectUriAllowed } from "@/lib/oauth/redirect-uri";
import { ConsentForm } from "./ConsentForm";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function pickString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function OAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  const response_type = pickString(params.response_type);
  const client_id = pickString(params.client_id);
  const redirect_uri = pickString(params.redirect_uri);
  const code_challenge = pickString(params.code_challenge);
  const code_challenge_method = pickString(params.code_challenge_method);
  const state = pickString(params.state) ?? "";
  const scope = pickString(params.scope) ?? "companion";
  const device_fingerprint = pickString(params.device_fingerprint);
  const device_name = pickString(params.device_name);

  if (response_type !== "code") {
    return <ErrorPanel message="Only response_type=code is supported." />;
  }
  if (!client_id || !redirect_uri || !code_challenge || code_challenge_method !== "S256") {
    return <ErrorPanel message="Missing or invalid OAuth parameters." />;
  }

  // If not logged in, bounce to /login with next= preserved.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries({
          response_type,
          client_id,
          redirect_uri,
          code_challenge,
          code_challenge_method,
          state,
          scope,
          device_fingerprint,
          device_name,
        }).filter(([, v]) => v !== undefined) as [string, string][],
      ),
    );
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${qs.toString()}`)}`);
  }

  // Validate client + redirect_uri server-side.
  const admin = createServiceClient();
  const { data: client } = await admin
    .from("oauth_clients")
    .select("id, name, redirect_uris, allowed_scopes, requires_pkce")
    .eq("id", client_id)
    .maybeSingle();

  if (!client) return <ErrorPanel message={`Unknown client: ${client_id}`} />;
  if (!isRedirectUriAllowed(client.redirect_uris, redirect_uri)) {
    return <ErrorPanel message="This redirect_uri is not registered for this client." />;
  }

  const fingerprintShort = device_fingerprint
    ? `${device_fingerprint.slice(0, 8)}…${device_fingerprint.slice(-4)}`
    : null;

  return (
    <div style={{ maxWidth: 480, margin: "80px auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Authorize {client.name}</h1>
      <p style={{ color: "#555", lineHeight: 1.5 }}>
        <strong>{client.name}</strong> wants to connect to your Guardian account.
      </p>

      <div style={{ background: "#f6f7f9", padding: 16, borderRadius: 8, margin: "16px 0" }}>
        <div style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>Signed in as</div>
        <div style={{ fontWeight: 500 }}>{user!.email}</div>
        {device_name && (
          <>
            <div style={{ fontSize: 13, color: "#666", marginTop: 12, marginBottom: 4 }}>Device</div>
            <div style={{ fontWeight: 500 }}>{device_name}</div>
          </>
        )}
        {fingerprintShort && (
          <>
            <div style={{ fontSize: 13, color: "#666", marginTop: 12, marginBottom: 4 }}>Fingerprint</div>
            <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>{fingerprintShort}</div>
          </>
        )}
        <div style={{ fontSize: 13, color: "#666", marginTop: 12, marginBottom: 4 }}>Scope</div>
        <div style={{ fontWeight: 500 }}>{scope}</div>
      </div>

      <p style={{ fontSize: 13, color: "#666" }}>
        This will allow the client to act on your behalf for the requested scope. You can revoke access at any time
        from your Account page.
      </p>

      <ConsentForm
        input={{
          client_id,
          redirect_uri,
          scope,
          state,
          code_challenge,
          code_challenge_method,
          device_fingerprint,
          device_name,
        }}
      />
    </div>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div style={{ maxWidth: 480, margin: "80px auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 12, color: "#b00020" }}>Authorization error</h1>
      <p style={{ color: "#555" }}>{message}</p>
    </div>
  );
}
