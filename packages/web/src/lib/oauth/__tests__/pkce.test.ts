import { describe, expect, it } from "vitest";
import {
  createRefreshToken,
  generateAuthCode,
  hashCodeChallenge,
  hashRefreshToken,
  isValidVerifier,
  verifyPKCE,
} from "../pkce";

describe("PKCE helpers", () => {
  // RFC 7636 Appendix B — reference vector.
  const rfcVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const rfcChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("matches RFC 7636 Appendix B S256 vector", () => {
    expect(hashCodeChallenge(rfcVerifier)).toBe(rfcChallenge);
  });

  it("verifyPKCE accepts the RFC vector", () => {
    expect(verifyPKCE(rfcVerifier, rfcChallenge)).toBe(true);
  });

  it("verifyPKCE rejects a mismatched verifier", () => {
    expect(verifyPKCE(rfcVerifier + "x", rfcChallenge)).toBe(false);
  });

  it("verifyPKCE rejects malformed verifiers", () => {
    expect(verifyPKCE("short", rfcChallenge)).toBe(false);
    expect(verifyPKCE("a".repeat(200), rfcChallenge)).toBe(false);
    expect(verifyPKCE("contains space " + "a".repeat(30), rfcChallenge)).toBe(false);
  });

  it("isValidVerifier enforces 43..128 unreserved chars", () => {
    expect(isValidVerifier("a".repeat(43))).toBe(true);
    expect(isValidVerifier("a".repeat(128))).toBe(true);
    expect(isValidVerifier("a".repeat(42))).toBe(false);
    expect(isValidVerifier("a".repeat(129))).toBe(false);
    expect(isValidVerifier("A-Z.a-z_0-9~" + "a".repeat(40))).toBe(true);
    expect(isValidVerifier("bad/chars" + "a".repeat(40))).toBe(false);
  });

  it("generateAuthCode produces 43-char base64url strings", () => {
    const code = generateAuthCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateAuthCode()).not.toBe(code);
  });

  it("createRefreshToken / hashRefreshToken round-trip", () => {
    const raw = createRefreshToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const hash = hashRefreshToken(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(raw)).toBe(hash);
    expect(hashRefreshToken(raw + "x")).not.toBe(hash);
  });
});
