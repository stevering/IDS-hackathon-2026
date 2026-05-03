/**
 * Tests for the PII redaction helpers.
 *
 * The contract: no helper output may contain conversation/argument values.
 * Only structural metadata (sizes, key names, role, success flag) is allowed.
 */

import { describe, it, expect } from "vitest";
import {
  redactArgs,
  redactMessage,
  redactPayload,
  redactResult,
} from "../lib/redact.js";

const SECRETS = [
  "Hello, my name is Stéphane and my email is abcd@abcd.io",
  "sk-proj-1234567890abcdef",
  "figma.createFrame(); return { ok: true };",
  "Voici mon avis confidentiel sur le design system",
];

function asString(value: unknown): string {
  return JSON.stringify(value);
}

function expectNoSecrets(value: unknown) {
  const serialized = asString(value);
  for (const secret of SECRETS) {
    expect(serialized, `leaked secret: ${secret}`).not.toContain(secret);
  }
}

describe("redactArgs", () => {
  it("returns key list and size, never values", () => {
    const args = {
      code: SECRETS[2],
      prompt: SECRETS[0],
      apiKey: SECRETS[1],
    };
    const out = redactArgs(args);
    expect(out.argKeys).toBe("code,prompt,apiKey");
    expect(out.argSize).toBeGreaterThan(0);
    expectNoSecrets(out);
  });

  it("handles primitives and null safely", () => {
    expect(redactArgs(null)).toEqual({ argKeys: "", argSize: 0 });
    expect(redactArgs(undefined)).toEqual({ argKeys: "", argSize: 0 });
    expect(redactArgs("plain string")).toEqual({ argKeys: "", argSize: 12 });
  });

  it("truncates long key lists", () => {
    const args: Record<string, string> = {};
    for (let i = 0; i < 20; i++) args[`k${i}`] = "v";
    const out = redactArgs(args);
    expect(out.argKeys).toMatch(/,\+\d+$/);
  });
});

describe("redactResult", () => {
  it("captures size and isError flag, never content", () => {
    const result = {
      content: [{ type: "text", text: SECRETS[3] }],
      isError: false,
    };
    const out = redactResult(result);
    expect(out.resultIsError).toBe(false);
    expect(out.resultKeys).toBe("content,isError");
    expect(out.resultSize).toBeGreaterThan(0);
    expectNoSecrets(out);
  });

  it("flags isError correctly", () => {
    expect(redactResult({ isError: true, message: "x" }).resultIsError).toBe(true);
    expect(redactResult({ isError: "truthy-but-not-true" }).resultIsError).toBe(false);
  });
});

describe("redactMessage", () => {
  it("returns role + lengths, never content", () => {
    const msg = {
      role: "user",
      content: SECRETS[0],
      toolCalls: [{ id: "t1", name: "x", arguments: {} }],
    };
    const out = redactMessage(msg);
    expect(out.role).toBe("user");
    expect(out.contentLen).toBe(SECRETS[0].length);
    expect(out.toolCallCount).toBe(1);
    expectNoSecrets(out);
  });

  it("supports both toolCalls and tool_calls naming", () => {
    expect(redactMessage({ role: "assistant", tool_calls: [1, 2, 3] }).toolCallCount).toBe(3);
  });

  it("handles malformed input", () => {
    expect(redactMessage(null).role).toBe("unknown");
    expect(redactMessage("string").role).toBe("unknown");
  });
});

describe("redactPayload", () => {
  it("returns keys + size, never values", () => {
    const payload = {
      message: SECRETS[0],
      response: SECRETS[3],
    };
    const out = redactPayload(payload);
    expect(out.payloadKeys).toBe("message,response");
    expectNoSecrets(out);
  });
});
