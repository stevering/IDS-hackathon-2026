"use client";

import { useState } from "react";
import { approveAuthorization, denyAuthorization } from "./actions";

type Input = {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  device_fingerprint?: string;
  device_name?: string;
};

export function ConsentForm({ input }: { input: Input }) {
  const [submitting, setSubmitting] = useState<"allow" | "deny" | null>(null);

  return (
    <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
      <button
        type="button"
        disabled={submitting !== null}
        onClick={async () => {
          setSubmitting("deny");
          const r = await denyAuthorization({ redirect_uri: input.redirect_uri, state: input.state });
          if (r.ok) window.location.href = r.url;
        }}
        style={{
          flex: 1,
          padding: "12px 16px",
          border: "1px solid #d0d0d0",
          background: "white",
          borderRadius: 6,
          cursor: submitting ? "default" : "pointer",
          fontSize: 15,
        }}
      >
        {submitting === "deny" ? "Cancelling…" : "Deny"}
      </button>
      <button
        type="button"
        disabled={submitting !== null}
        onClick={async () => {
          setSubmitting("allow");
          const r = await approveAuthorization(input);
          if (r.ok) window.location.href = r.url;
          else setSubmitting(null);
        }}
        style={{
          flex: 1,
          padding: "12px 16px",
          border: "none",
          background: "#0b5fff",
          color: "white",
          borderRadius: 6,
          cursor: submitting ? "default" : "pointer",
          fontSize: 15,
          fontWeight: 500,
        }}
      >
        {submitting === "allow" ? "Authorizing…" : "Allow"}
      </button>
    </div>
  );
}
