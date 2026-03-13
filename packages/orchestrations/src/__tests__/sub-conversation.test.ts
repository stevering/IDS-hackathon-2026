import { describe, it, expect } from "vitest";
import {
  createSubConversation,
  isSubConvTimedOut,
  createTimeoutClose,
  canJoinSubConversation,
  MAX_SUB_CONV_DURATION_MS,
} from "../engine/sub-conversation.js";
import type { SubConvInvitePayload } from "../types/signals.js";

function makeInvite(overrides?: Partial<SubConvInvitePayload>): SubConvInvitePayload {
  return {
    subConvId: "sc-1",
    initiatorId: "agent-a",
    participantIds: ["agent-b"],
    topic: "Design tokens",
    durationMs: 120_000,
    ...overrides,
  };
}

describe("createSubConversation", () => {
  it("creates state from invite payload", () => {
    const state = createSubConversation(makeInvite());
    expect(state.id).toBe("sc-1");
    expect(state.initiatorId).toBe("agent-a");
    expect(state.participantIds).toEqual(["agent-b"]);
    expect(state.topic).toBe("Design tokens");
    expect(state.durationMs).toBe(120_000);
  });

  it("caps duration at MAX_SUB_CONV_DURATION_MS", () => {
    const state = createSubConversation(makeInvite({ durationMs: 999_999 }));
    expect(state.durationMs).toBe(MAX_SUB_CONV_DURATION_MS);
  });
});

describe("isSubConvTimedOut", () => {
  it("returns false when within duration", () => {
    const state = createSubConversation(makeInvite());
    // startedAt is now, so not timed out
    expect(isSubConvTimedOut(state)).toBe(false);
  });

  it("returns true when past duration", () => {
    const state = createSubConversation(makeInvite({ durationMs: 1 }));
    // Set startedAt to 1s ago
    state.startedAt = new Date(Date.now() - 2000).toISOString();
    expect(isSubConvTimedOut(state)).toBe(true);
  });
});

describe("createTimeoutClose", () => {
  it("creates close payload with timeout reason", () => {
    const state = createSubConversation(makeInvite());
    const close = createTimeoutClose(state);
    expect(close.subConvId).toBe("sc-1");
    expect(close.reason).toBe("timeout");
  });
});

describe("canJoinSubConversation", () => {
  it("allows joining when no active sub-conversation", () => {
    const result = canJoinSubConversation(null, makeInvite());
    expect(result.canJoin).toBe(true);
  });

  it("rejects joining when already in a sub-conversation", () => {
    const active = createSubConversation(makeInvite({ subConvId: "sc-existing" }));
    const result = canJoinSubConversation(active, makeInvite({ subConvId: "sc-new" }));
    expect(result.canJoin).toBe(false);
    expect(result.reason).toContain("Already in sub-conversation");
  });
});
