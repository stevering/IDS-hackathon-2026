import { createHash, randomBytes } from "node:crypto";

// RFC 7636 — PKCE helpers (S256 only; plain is forbidden).

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Auth code: 43+ char URL-safe random. 32 random bytes → 43 base64url chars.
export function generateAuthCode(): string {
  return base64url(randomBytes(32));
}

// Opaque refresh token: 48 bytes → 64 base64url chars.
export function createRefreshToken(): string {
  return base64url(randomBytes(48));
}

export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Computes the S256 challenge from a verifier: BASE64URL(SHA256(ASCII(verifier))).
export function hashCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

// Verifier must match RFC 7636 §4.1: 43..128 unreserved chars.
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidVerifier(verifier: string): boolean {
  return VERIFIER_RE.test(verifier);
}

// Constant-time string comparison, guarded against length mismatch.
export function verifyPKCE(verifier: string, storedChallenge: string): boolean {
  if (!isValidVerifier(verifier)) return false;
  const computed = hashCodeChallenge(verifier);
  if (computed.length !== storedChallenge.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ storedChallenge.charCodeAt(i);
  }
  return diff === 0;
}
