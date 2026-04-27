/**
 * Encrypted session storage for the Desktop Companion.
 *
 * Uses Electron `safeStorage` → macOS Keychain, Windows DPAPI, Linux libsecret.
 * Falls back to plaintext JSON with a console warning when safeStorage is
 * unavailable (Linux without libsecret configured).
 */

import { safeStorage } from "electron";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const FILE_NAME = "guardian-session.enc";
const PLAINTEXT_FALLBACK = "guardian-session.json";

export type StoredSession = {
  access_token: string;
  supabase_refresh_token: string;
  refresh_token: string; // Guardian OAuth refresh token (for /api/oauth/token)
  user_id: string;
  device_id: string | null;
  scope: string;
  // Unix epoch seconds; used to decide whether to refresh proactively.
  access_token_expires_at: number;
  cloud_url: string;
  supabase_url: string;
  supabase_anon_key: string;
  saved_at: number;
};

function encPath(userDataPath: string): string {
  return join(userDataPath, FILE_NAME);
}

function plainPath(userDataPath: string): string {
  return join(userDataPath, PLAINTEXT_FALLBACK);
}

export function saveSession(userDataPath: string, session: StoredSession): void {
  const json = JSON.stringify(session);

  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(json);
    writeFileSync(encPath(userDataPath), encrypted);
    // Remove any stale plaintext fallback from a previous install.
    try { unlinkSync(plainPath(userDataPath)); } catch { /* ok */ }
  } else {
    console.warn(
      "[session-store] safeStorage unavailable — writing session in plaintext. " +
        "Configure libsecret on Linux for encrypted storage.",
    );
    writeFileSync(plainPath(userDataPath), json, { mode: 0o600 });
  }
}

export function loadSession(userDataPath: string): StoredSession | null {
  // Prefer the encrypted file when it exists.
  const enc = encPath(userDataPath);
  if (existsSync(enc) && safeStorage.isEncryptionAvailable()) {
    try {
      const buf = readFileSync(enc);
      const json = safeStorage.decryptString(buf);
      return JSON.parse(json) as StoredSession;
    } catch (e) {
      console.error("[session-store] Failed to decrypt session:", e);
      // Fall through to plaintext fallback below.
    }
  }

  const plain = plainPath(userDataPath);
  if (existsSync(plain)) {
    try {
      return JSON.parse(readFileSync(plain, "utf-8")) as StoredSession;
    } catch (e) {
      console.error("[session-store] Failed to read plaintext session:", e);
    }
  }

  return null;
}

export function clearSession(userDataPath: string): void {
  for (const p of [encPath(userDataPath), plainPath(userDataPath)]) {
    try { unlinkSync(p); } catch { /* already gone */ }
  }
}

export function isAccessTokenExpired(session: StoredSession, skewSeconds = 60): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now + skewSeconds >= session.access_token_expires_at;
}

/**
 * Best-effort extraction of the user email from the Supabase JWT payload.
 * Parses the unverified JWT body — no signature check is needed because we
 * only display the value in our own menus, never trust it for authorisation.
 */
export function getSessionEmail(session: StoredSession): string | null {
  try {
    const payload = session.access_token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    const email = decoded?.email;
    return typeof email === "string" && email.length > 0 ? email : null;
  } catch (e) {
    console.error("[session-store] Failed to decode JWT email:", e);
    return null;
  }
}
