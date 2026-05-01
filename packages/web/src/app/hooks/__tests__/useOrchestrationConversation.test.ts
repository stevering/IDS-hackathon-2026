import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useOrchestrationConversation } from "../useOrchestrationConversation";
import type { Conversation } from "../useConversations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConv(partial: Partial<Conversation>): Conversation {
  return {
    id: partial.id ?? "conv-?",
    user_id: "user-1",
    client_id: null,
    title: partial.title ?? "Untitled",
    is_active: true,
    parent_id: partial.parent_id ?? null,
    orchestration_id: null,
    metadata: partial.metadata ?? {},
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// Auto-switch gate (isFigmaPlugin)
// ---------------------------------------------------------------------------

describe("useOrchestrationConversation — isFigmaPlugin auto-switch gate", () => {
  it("auto-switches to the new sub-conv on creation when isFigmaPlugin is false (webapp)", async () => {
    const switchConversation = vi.fn();
    const newSubConv = makeConv({
      id: "sub-1",
      title: "Orchestration",
      parent_id: "parent-1",
      metadata: { workflowId: "wf-1" },
    });
    const createConversation = vi.fn().mockResolvedValue(newSubConv);

    renderHook(() =>
      useOrchestrationConversation({
        workflowId: "wf-1",
        activeConversationId: "parent-1",
        conversations: [makeConv({ id: "parent-1", title: "Parent chat" })],
        createConversation,
        switchConversation,
        isFigmaPlugin: false,
      }),
    );

    await waitFor(() => expect(createConversation).toHaveBeenCalledTimes(1));
    expect(switchConversation).toHaveBeenCalledWith("sub-1");
  });

  it("does NOT auto-switch on creation when isFigmaPlugin is true (silent sub-conv)", async () => {
    const switchConversation = vi.fn();
    const newSubConv = makeConv({
      id: "sub-1",
      title: "Orchestration",
      parent_id: "parent-1",
      metadata: { workflowId: "wf-1" },
    });
    const createConversation = vi.fn().mockResolvedValue(newSubConv);

    renderHook(() =>
      useOrchestrationConversation({
        workflowId: "wf-1",
        activeConversationId: "parent-1",
        conversations: [makeConv({ id: "parent-1", title: "Parent chat" })],
        createConversation,
        switchConversation,
        isFigmaPlugin: true,
      }),
    );

    await waitFor(() => expect(createConversation).toHaveBeenCalledTimes(1));
    expect(switchConversation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Existing sub-conv detection
// ---------------------------------------------------------------------------

describe("useOrchestrationConversation — existing sub-conv detection", () => {
  it("matches by metadata.workflowId when a workflowId hint is provided", () => {
    const parent = makeConv({ id: "parent-1" });
    const subConv = makeConv({
      id: "sub-1",
      title: "Orchestration",
      parent_id: "parent-1",
      metadata: { workflowId: "wf-1" },
    });

    const { result } = renderHook(() =>
      useOrchestrationConversation({
        workflowId: "wf-1",
        activeConversationId: "sub-1",
        conversations: [parent, subConv],
        createConversation: vi.fn(),
        switchConversation: vi.fn(),
      }),
    );

    expect(result.current.orchestrationConversationId).toBe("sub-1");
    expect(result.current.isInOrchestrationConversation).toBe(true);
    expect(result.current.hasActiveOrchestration).toBe(true);
    expect(result.current.isRelatedToOrchestration).toBe(true);
  });

  it("falls back to parent_id-based detection when no workflowId hint exists", () => {
    // User is on the parent chat. workflowId prop is null (no live workflow,
    // never seen one before). The fallback should still find the child sub-conv
    // via parent_id and surface it through `orchestrationConversationId`.
    const parent = makeConv({ id: "parent-1" });
    const subConv = makeConv({
      id: "sub-1",
      title: "Orchestration",
      parent_id: "parent-1",
      metadata: { workflowId: "wf-1" },
    });

    const { result } = renderHook(() =>
      useOrchestrationConversation({
        workflowId: null,
        activeConversationId: "parent-1",
        conversations: [parent, subConv],
        createConversation: vi.fn(),
        switchConversation: vi.fn(),
      }),
    );

    expect(result.current.orchestrationConversationId).toBe("sub-1");
    expect(result.current.isRelatedToOrchestration).toBe(true);
    // We are on the parent, not the sub-conv itself
    expect(result.current.isInOrchestrationConversation).toBe(false);
  });

  it("ignores child conversations that have no metadata.workflowId in the parent_id fallback", () => {
    const parent = makeConv({ id: "parent-1" });
    const unrelatedChild = makeConv({
      id: "child-1",
      title: "Other child",
      parent_id: "parent-1",
      metadata: {}, // no workflowId
    });

    const { result } = renderHook(() =>
      useOrchestrationConversation({
        workflowId: null,
        activeConversationId: "parent-1",
        conversations: [parent, unrelatedChild],
        createConversation: vi.fn(),
        switchConversation: vi.fn(),
      }),
    );

    expect(result.current.orchestrationConversationId).toBeNull();
    expect(result.current.isRelatedToOrchestration).toBe(false);
  });

  it("does not create a new sub-conv when one already exists for the workflowId", async () => {
    const parent = makeConv({ id: "parent-1" });
    const existingSub = makeConv({
      id: "sub-1",
      title: "Orchestration",
      parent_id: "parent-1",
      metadata: { workflowId: "wf-1" },
    });
    const createConversation = vi.fn();

    renderHook(() =>
      useOrchestrationConversation({
        workflowId: "wf-1",
        activeConversationId: "parent-1",
        conversations: [parent, existingSub],
        createConversation,
        switchConversation: vi.fn(),
      }),
    );

    // Wait a tick for any potential async creation to fire
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(createConversation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// switchToOrchestration / switchBackToChat
// ---------------------------------------------------------------------------

describe("useOrchestrationConversation — navigation callbacks", () => {
  it("switchToOrchestration switches to the sub-conv id", () => {
    const switchConversation = vi.fn();
    const parent = makeConv({ id: "parent-1" });
    const subConv = makeConv({
      id: "sub-1",
      parent_id: "parent-1",
      metadata: { workflowId: "wf-1" },
    });

    const { result } = renderHook(() =>
      useOrchestrationConversation({
        workflowId: null,
        activeConversationId: "parent-1",
        conversations: [parent, subConv],
        createConversation: vi.fn(),
        switchConversation,
      }),
    );

    act(() => {
      result.current.switchToOrchestration();
    });
    expect(switchConversation).toHaveBeenCalledWith("sub-1");
  });

  it("switchBackToChat switches to the sub-conv's parent_id", () => {
    const switchConversation = vi.fn();
    const parent = makeConv({ id: "parent-1" });
    const subConv = makeConv({
      id: "sub-1",
      parent_id: "parent-1",
      metadata: { workflowId: "wf-1" },
    });

    const { result } = renderHook(() =>
      useOrchestrationConversation({
        workflowId: "wf-1",
        activeConversationId: "sub-1",
        conversations: [parent, subConv],
        createConversation: vi.fn(),
        switchConversation,
      }),
    );

    act(() => {
      result.current.switchBackToChat();
    });
    expect(switchConversation).toHaveBeenCalledWith("parent-1");
  });
});
