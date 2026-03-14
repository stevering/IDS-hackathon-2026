import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTemporalOrchestration } from "../useTemporalOrchestration";

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
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ workflowId: "wf-started-123" }),
      }),
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests — useTemporalOrchestration conversation isolation
// ---------------------------------------------------------------------------

describe("useTemporalOrchestration — initial state", () => {
  it("starts with workflowId=null, isActive=false, empty events and agents", () => {
    const { result } = renderHook(() => useTemporalOrchestration());

    expect(result.current.workflowId).toBeNull();
    expect(result.current.isActive).toBe(false);
    expect(result.current.events).toEqual([]);
    expect(result.current.agents).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.starting).toBe(false);
    expect(result.current.connected).toBe(false);
  });
});

describe("useTemporalOrchestration — startOrchestration", () => {
  it("sets workflowId after successful start", async () => {
    const { result } = renderHook(() => useTemporalOrchestration());

    await act(async () => {
      const wfId = await result.current.startOrchestration({
        task: "Create buttons",
        targetAgents: [
          {
            shortId: "a",
            workflowId: "wf-a",
            label: "Agent A",
            type: "figma-plugin",
          },
        ],
      });
      expect(wfId).toBe("wf-started-123");
    });

    expect(result.current.workflowId).toBe("wf-started-123");
    expect(result.current.starting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("sets error on failed start", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: "Server error" }),
        }),
      ),
    );

    const { result } = renderHook(() => useTemporalOrchestration());

    await act(async () => {
      const wfId = await result.current.startOrchestration({
        task: "Create buttons",
        targetAgents: [
          {
            shortId: "a",
            workflowId: "wf-a",
            label: "Agent A",
            type: "figma-plugin",
          },
        ],
      });
      expect(wfId).toBeNull();
    });

    expect(result.current.workflowId).toBeNull();
    expect(result.current.error).toBe("Server error");
  });
});

describe("useTemporalOrchestration — reset clears state", () => {
  it("reset() clears workflowId, events, agents, and errors", async () => {
    const { result } = renderHook(() => useTemporalOrchestration());

    // Start an orchestration
    await act(async () => {
      await result.current.startOrchestration({
        task: "Create buttons",
        targetAgents: [
          {
            shortId: "a",
            workflowId: "wf-a",
            label: "Agent A",
            type: "figma-plugin",
          },
        ],
      });
    });

    expect(result.current.workflowId).toBe("wf-started-123");

    // Simulate some stream events
    const es = MockEventSource.instances[0];
    act(() => {
      es.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "orchestrator_thinking",
            content: "planning...",
          }),
        }),
      );
    });
    expect(result.current.events).toHaveLength(1);

    // Reset
    act(() => {
      result.current.reset();
    });

    expect(result.current.workflowId).toBeNull();
    expect(result.current.events).toEqual([]);
    expect(result.current.agents).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.isActive).toBe(false);
    expect(result.current.connected).toBe(false);
  });

  it("after reset, isActive is false", async () => {
    const { result } = renderHook(() => useTemporalOrchestration());

    await act(async () => {
      await result.current.startOrchestration({
        task: "Test",
        targetAgents: [
          {
            shortId: "b",
            workflowId: "wf-b",
            label: "Agent B",
            type: "figma-plugin",
          },
        ],
      });
    });

    // Before reset: isActive should be true (workflowId set, not completed)
    expect(result.current.isActive).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.isActive).toBe(false);
  });

  it("reset disconnects the EventSource", async () => {
    const { result } = renderHook(() => useTemporalOrchestration());

    await act(async () => {
      await result.current.startOrchestration({
        task: "Test",
        targetAgents: [
          {
            shortId: "c",
            workflowId: "wf-c",
            label: "Agent C",
            type: "figma-plugin",
          },
        ],
      });
    });

    const es = MockEventSource.instances[0];

    act(() => {
      result.current.reset();
    });

    // The EventSource should have been closed
    expect(es.close).toHaveBeenCalled();
  });
});

describe("useTemporalOrchestration — state isolation across resets", () => {
  it("events from previous orchestration do not leak after reset + new start", async () => {
    const { result } = renderHook(() => useTemporalOrchestration());

    // First orchestration
    await act(async () => {
      await result.current.startOrchestration({
        task: "First task",
        targetAgents: [
          {
            shortId: "a",
            workflowId: "wf-a",
            label: "Agent A",
            type: "figma-plugin",
          },
        ],
      });
    });

    // Receive events on first orchestration
    const es1 = MockEventSource.instances[0];
    act(() => {
      es1.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "orchestrator_thinking",
            content: "first orchestration event",
          }),
        }),
      );
    });
    expect(result.current.events).toHaveLength(1);

    // Reset (simulates conversation switch)
    act(() => {
      result.current.reset();
    });
    expect(result.current.events).toEqual([]);

    // Second orchestration
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ workflowId: "wf-started-456" }),
        }),
      ),
    );

    await act(async () => {
      await result.current.startOrchestration({
        task: "Second task",
        targetAgents: [
          {
            shortId: "b",
            workflowId: "wf-b",
            label: "Agent B",
            type: "figma-plugin",
          },
        ],
      });
    });

    expect(result.current.workflowId).toBe("wf-started-456");
    // Events should be empty — nothing from the first orchestration
    expect(result.current.events).toEqual([]);

    // Receive event on second orchestration
    const es2 = MockEventSource.instances[MockEventSource.instances.length - 1];
    act(() => {
      es2.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "orchestrator_thinking",
            content: "second orchestration event",
          }),
        }),
      );
    });

    expect(result.current.events).toHaveLength(1);
    expect((result.current.events[0] as { content: string }).content).toBe(
      "second orchestration event",
    );
  });
});
