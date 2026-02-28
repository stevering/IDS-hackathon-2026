"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await authClient.signUp.email({ email, password, name });

    if (error) {
      setError(error.message ?? "Inscription échouée");
      setLoading(false);
    } else {
      window.location.href = "/";
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-3xl mb-2">🛡</div>
          <h1 className="text-xl font-semibold">DS AI Guardian</h1>
          <p className="text-sm text-white/50 mt-1">Créez votre compte</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="text"
            placeholder="Nom"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm outline-none focus:border-white/30 transition-colors"
          />
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
            placeholder="Mot de passe"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
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
            {loading ? "Création…" : "Créer mon compte"}
          </button>
        </form>

        <p className="text-center text-sm text-white/40 mt-6">
          Déjà un compte ?{" "}
          <Link href="/login" className="text-white/70 hover:text-white transition-colors">
            Se connecter
          </Link>
        </p>
      </div>
    </div>
  );
}
