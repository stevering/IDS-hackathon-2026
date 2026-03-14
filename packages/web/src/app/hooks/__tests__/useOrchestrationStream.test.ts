import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOrchestrationStream } from "../useOrchestrationStream";

// ---------------------------------------------------------------------------
// Mock EventSource (not available in jsdom)
// ---------------------------------------------------------------------------

class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  close = vi.fn();
  url: string;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests — useOrchestrationStream conversation isolation
// ---------------------------------------------------------------------------

describe("useOrchestrationStream — initial state", () => {
  it("returns correct initial state when workflowId is null", () => {
    const { result } = renderHook(() => useOrchestrationStream(null));

    expect(result.current.connected).toBe(false);
    expect(result.current.agents).toEqual([]);
    expect(result.current.events).toEqual([]);
    expect(result.current.timerRemainingMs).toBeNull();
    expect(result.current.totalDurationMs).toBe(600_000);
    expect(result.current.completedStatus).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("does not create an EventSource when workflowId is null", () => {
    renderHook(() => useOrchestrationStream(null));
    expect(MockEventSource.instances).toHaveLength(0);
  });
});

describe("useOrchestrationStream — workflowId changes (conversation switch)", () => {
  it("resets to initial state when workflowId changes to null", () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useOrchestrationStream(id),
      { initialProps: { id: "wf-123" } },
    );

    // Simulate receiving events on the first workflow
    const es = MockEventSource.instances[0];
    act(() => {
      es.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "orchestrator_thinking",
            content: "thinking...",
          }),
        }),
      );
    });
    expect(result.current.events).toHaveLength(1);

    // Switch conversation: set workflowId to null
    rerender({ id: null });

    expect(result.current.connected).toBe(false);
    expect(result.current.agents).toEqual([]);
    expect(result.current.events).toEqual([]);
    expect(result.current.timerRemainingMs).toBeNull();
    expect(result.current.completedStatus).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("closes old EventSource and resets state when switching workflows", () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useOrchestrationStream(id),
      { initialProps: { id: "wf-aaa" } },
    );

    const firstEs = MockEventSource.instances[0];

    // Simulate some events on first workflow
    act(() => {
      firstEs.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "orchestrator_thinking",
            content: "from workflow aaa",
          }),
        }),
      );
    });
    expect(result.current.events).toHaveLength(1);

    // Switch to a new workflow
    rerender({ id: "wf-bbb" });

    // Old EventSource should be closed
    expect(firstEs.close).toHaveBeenCalled();

    // State should be reset — no events from the previous workflow
    expect(result.current.events).toHaveLength(0);
    expect(result.current.connected).toBe(false);

    // A new EventSource should be created for the new workflow
    const secondEs = MockEventSource.instances[1];
    expect(secondEs.url).toBe("/api/orchestration/wf-bbb/stream");
  });

  it("creates EventSource with correct URL for the given workflowId", () => {
    renderHook(() => useOrchestrationStream("my-workflow-42"));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe(
      "/api/orchestration/my-workflow-42/stream",
    );
  });
});

describe("useOrchestrationStream — disconnect resets state", () => {
  it("disconnect() resets to initial state and closes EventSource", () => {
    const { result } = renderHook(() => useOrchestrationStream("wf-xyz"));

    const es = MockEventSource.instances[0];

    // Simulate receiving an event
    act(() => {
      es.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "orchestrator_thinking",
            content: "data",
          }),
        }),
      );
    });
    expect(result.current.events).toHaveLength(1);

    // Call disconnect
    act(() => {
      result.current.disconnect();
    });

    expect(result.current.connected).toBe(false);
    expect(result.current.agents).toEqual([]);
    expect(result.current.events).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(es.close).toHaveBeenCalled();
  });
});

describe("useOrchestrationStream — event accumulation and isolation", () => {
  it("accumulates events for a single workflow", () => {
    const { result } = renderHook(() => useOrchestrationStream("wf-test"));

    const es = MockEventSource.instances[0];

    act(() => {
      es.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "orchestrator_thinking",
            content: "event 1",
          }),
        }),
      );
    });
    act(() => {
      es.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "orchestrator_thinking",
            content: "event 2",
          }),
        }),
      );
    });

    expect(result.current.events).toHaveLength(2);
  });

  it("events from old workflow do not appear after switching", () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useOrchestrationStream(id),
      { initialProps: { id: "wf-old" } },
    );

    const oldEs = MockEventSource.instances[0];

    // Add events to old workflow
    act(() => {
      oldEs.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "orchestrator_thinking",
            content: "old event",
          }),
        }),
      );
    });
    expect(result.current.events).toHaveLength(1);

    // Switch to new workflow
    rerender({ id: "wf-new" });

    // Events should be clean
    expect(result.current.events).toHaveLength(0);

    // Add event to new workflow
    const newEs = MockEventSource.instances[1];
    act(() => {
      newEs.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "orchestrator_thinking",
            content: "new event",
          }),
        }),
      );
    });

    expect(result.current.events).toHaveLength(1);
    expect((result.current.events[0] as { content: string }).content).toBe(
      "new event",
    );
  });
});
