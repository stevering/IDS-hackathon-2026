"use client";

import { useState, useEffect } from "react";

interface Invite {
  id: string;
  email: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  invited_at: string;
  accepted_at: string | null;
}

export default function AdminInvitePage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(true);

  async function fetchInvites() {
    try {
      const res = await fetch("/api/admin/invites");
      if (res.ok) {
        const data = await res.json();
        setInvites(data.invites ?? []);
      }
    } finally {
      setLoadingInvites(false);
    }
  }

  useEffect(() => {
    fetchInvites();
  }, []);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      const data = await res.json();

      if (res.ok) {
        setMessage({ type: "success", text: `Invite sent to ${data.email}` });
        setEmail("");
        fetchInvites();
      } else {
        setMessage({ type: "error", text: data.error ?? "Failed to send invite" });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setLoading(false);
    }
  }

  const statusColors: Record<string, string> = {
    pending: "text-amber-400 bg-amber-400/10",
    accepted: "text-emerald-400 bg-emerald-400/10",
    expired: "text-white/30 bg-white/5",
    revoked: "text-red-400 bg-red-400/10",
  };

  return (
    <div className="min-h-screen flex items-start justify-center px-4 pt-20">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-10 text-center">
          <div className="text-3xl mb-2">🛡</div>
          <h1 className="text-xl font-semibold">Guardian — Admin</h1>
          <p className="text-sm text-white/50 mt-1">Private beta invite management</p>
        </div>

        {/* Invite form */}
        <form onSubmit={handleInvite} className="flex gap-2 mb-8">
          <input
            type="email"
            placeholder="Email address to invite"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="flex-1 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/30 transition-colors"
          />
          <button
            type="submit"
            disabled={loading}
            className="px-5 py-2.5 rounded-lg bg-white text-black text-sm font-medium disabled:opacity-40 transition-opacity whitespace-nowrap"
          >
            {loading ? "Sending…" : "Send invite"}
          </button>
        </form>

        {message && (
          <div
            className={`mb-6 px-4 py-2.5 rounded-lg text-sm ${
              message.type === "success"
                ? "bg-emerald-400/10 text-emerald-400 border border-emerald-400/20"
                : "bg-red-400/10 text-red-400 border border-red-400/20"
            }`}
          >
            {message.text}
          </div>
        )}

        {/* Invites list */}
        <div>
          <h2 className="text-sm font-medium text-white/70 mb-3">
            Invites ({invites.length})
          </h2>

          {loadingInvites ? (
            <p className="text-sm text-white/30">Loading…</p>
          ) : invites.length === 0 ? (
            <p className="text-sm text-white/30">No invites sent yet</p>
          ) : (
            <div className="space-y-2">
              {invites.map((invite) => (
                <div
                  key={invite.id}
                  className="flex items-center justify-between px-4 py-3 rounded-lg bg-white/[0.03] border border-white/[0.06]"
                >
                  <div>
                    <p className="text-sm">{invite.email}</p>
                    <p className="text-xs text-white/30 mt-0.5">
                      Invited {new Date(invite.invited_at).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                      {invite.accepted_at && (
                        <> — Accepted {new Date(invite.accepted_at).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}</>
                      )}
                    </p>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[invite.status] ?? "text-white/30"}`}
                  >
                    {invite.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
