import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock Supabase channel + presence
// ---------------------------------------------------------------------------

type PresenceHandler = (state: Record<string, unknown[]>) => void;
type BroadcastHandler = (payload: { payload: unknown }) => void;
type SubscribeCallback = (status: string) => void;

class MockChannel {
  private presenceHandlers: PresenceHandler[] = [];
  private broadcastHandlers: Map<string, BroadcastHandler[]> = new Map();
  private subscribeCallback: SubscribeCallback | null = null;
  private _presenceState: Record<string, unknown[]> = {};

  track = vi.fn(async () => {});
  unsubscribe = vi.fn();
  send = vi.fn();
  socket = { isConnected: vi.fn(() => true) };

  on(type: string, filter: { event: string }, handler: unknown) {
    if (type === "presence") {
      this.presenceHandlers.push(handler as PresenceHandler);
    } else if (type === "broadcast") {
      const handlers = this.broadcastHandlers.get(filter.event) ?? [];
      handlers.push(handler as BroadcastHandler);
      this.broadcastHandlers.set(filter.event, handlers);
    }
    return this;
  }

  subscribe(cb?: SubscribeCallback) {
    this.subscribeCallback = cb ?? null;
    // Auto-fire SUBSCRIBED
    setTimeout(() => this.subscribeCallback?.("SUBSCRIBED"), 0);
    return this;
  }

  presenceState() {
    return this._presenceState;
  }

  // Test helpers
  _firePresenceSync(state: Record<string, unknown[]>) {
    this._presenceState = state;
    for (const h of this.presenceHandlers) {
      h(state);
    }
  }

  _fireSubscribeStatus(status: string) {
    this.subscribeCallback?.(status);
  }

  _fireBroadcast(event: string, payload: unknown) {
    const handlers = this.broadcastHandlers.get(event) ?? [];
    for (const h of handlers) {
      h({ payload });
    }
  }
}

let mockChannel: MockChannel;
let mockGetUser: ReturnType<typeof vi.fn>;

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: (_name: string, _opts?: unknown) => {
      mockChannel = new MockChannel();
      return mockChannel;
    },
    auth: {
      getUser: () => mockGetUser(),
    },
  }),
}));

// Must import after mock
import { useFigmaExecuteChannel } from "../useFigmaExecuteChannel";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const noopExecute = vi.fn(async () => ({ success: true as const, result: "ok" }));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockGetUser = vi.fn(() =>
    Promise.resolve({ data: { user: { id: "user-123" } } })
  );
  // Stub storage
  vi.stubGlobal("sessionStorage", {
    getItem: () => "test-client-id",
    setItem: vi.fn(),
  });
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useFigmaExecuteChannel — connection status", () => {
  it("starts with 'connecting' status", async () => {
    const { result } = renderHook(() =>
      useFigmaExecuteChannel(noopExecute, true, {
        type: "webapp",
        label: "Test",
      })
    );

    expect(result.current.connectionStatus).toBe("connecting");
  });

  it("transitions to 'connected' on first presence sync", async () => {
    const { result } = renderHook(() =>
      useFigmaExecuteChannel(noopExecute, true, {
        type: "webapp",
        label: "Test",
      })
    );

    // Wait for auth + subscribe
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Fire presence sync
    await act(async () => {
      mockChannel._firePresenceSync({
        "user-123": [
          { presence_ref: "ref-1", clientId: "client-a", type: "webapp", label: "Browser" },
        ],
      });
    });

    expect(result.current.connectionStatus).toBe("connected");
    expect(result.current.clients).toHaveLength(1);
    expect(result.current.clients[0].clientId).toBe("client-a");
  });

  it("transitions to 'connected' after fallback timeout when no sync arrives", async () => {
    const { result } = renderHook(() =>
      useFigmaExecuteChannel(noopExecute, true, {
        type: "webapp",
        label: "Test",
      })
    );

    // Wait for auth + subscribe
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.connectionStatus).toBe("connecting");

    // Advance past the 5s fallback timeout
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });

    expect(result.current.connectionStatus).toBe("connected");
    // No fake clients injected — clients stays empty
    expect(result.current.clients).toHaveLength(0);
  });
});

describe("useFigmaExecuteChannel — keepalive interval", () => {
  it("calls track on keepalive intervals", async () => {
    renderHook(() =>
      useFigmaExecuteChannel(noopExecute, true, {
        type: "webapp",
        label: "Test",
      })
    );

    // Wait for auth + subscribe
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Reset track call count after initial setup
    mockChannel.track.mockClear();

    // Advance 10s — first keepalive
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Keepalive should have called track (re-track presence)
    expect(mockChannel.track.mock.calls.length).toBeGreaterThanOrEqual(1);

    mockChannel.track.mockClear();

    // Advance another 10s — second keepalive
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mockChannel.track.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("useFigmaExecuteChannel — disabled", () => {
  it("does not subscribe when disabled", () => {
    const { result } = renderHook(() =>
      useFigmaExecuteChannel(noopExecute, false, {
        type: "webapp",
        label: "Test",
      })
    );

    expect(result.current.clients).toHaveLength(0);
    expect(result.current.connectionStatus).toBe("connecting");
  });
});

describe("useFigmaExecuteChannel — presence updates", () => {
  it("updates clients when presence syncs with multiple clients", async () => {
    const { result } = renderHook(() =>
      useFigmaExecuteChannel(noopExecute, true, {
        type: "webapp",
        label: "Test",
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Sync with 2 clients
    await act(async () => {
      mockChannel._firePresenceSync({
        "user-123": [
          { presence_ref: "ref-1", clientId: "client-a", type: "figma-plugin", label: "Figma A" },
          { presence_ref: "ref-2", clientId: "client-b", type: "webapp", label: "Browser" },
        ],
      });
    });

    expect(result.current.clients).toHaveLength(2);

    // One client leaves
    await act(async () => {
      mockChannel._firePresenceSync({
        "user-123": [
          { presence_ref: "ref-2", clientId: "client-b", type: "webapp", label: "Browser" },
        ],
      });
    });

    expect(result.current.clients).toHaveLength(1);
    expect(result.current.clients[0].clientId).toBe("client-b");
  });
});

// ---------------------------------------------------------------------------
// Execute request broadcast
// ---------------------------------------------------------------------------

describe("useFigmaExecuteChannel — execute_request broadcast", () => {
  it("figma-plugin client executes code and sends result", async () => {
    const executeCode = vi.fn(async () => ({ success: true as const, result: "done" }));

    renderHook(() =>
      useFigmaExecuteChannel(executeCode, true, {
        type: "figma-plugin",
        label: "Plugin",
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Fire execute_request broadcast
    await act(async () => {
      mockChannel._fireBroadcast("execute_request", {
        requestId: "req-1",
        code: "console.log('hi')",
        timeout: 5000,
      });
      // Let the async handler resolve
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(executeCode).toHaveBeenCalledWith("console.log('hi')", 5000);
    expect(mockChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "broadcast",
        event: "execute_result",
        payload: expect.objectContaining({
          requestId: "req-1",
          success: true,
          result: "done",
        }),
      })
    );
  });

  it("webapp client ignores execute_request", async () => {
    const executeCode = vi.fn(async () => ({ success: true as const, result: "done" }));

    renderHook(() =>
      useFigmaExecuteChannel(executeCode, true, {
        type: "webapp",
        label: "Browser",
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    await act(async () => {
      mockChannel._fireBroadcast("execute_request", {
        requestId: "req-1",
        code: "console.log('hi')",
        timeout: 5000,
      });
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(executeCode).not.toHaveBeenCalled();
    expect(mockChannel.send).not.toHaveBeenCalled();
  });

  it("ignores execute_request targeted at a different client", async () => {
    const executeCode = vi.fn(async () => ({ success: true as const, result: "done" }));

    renderHook(() =>
      useFigmaExecuteChannel(executeCode, true, {
        type: "figma-plugin",
        label: "Plugin",
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    await act(async () => {
      mockChannel._fireBroadcast("execute_request", {
        requestId: "req-1",
        code: "console.log('hi')",
        timeout: 5000,
        targetClientId: "some-other-client",
      });
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(executeCode).not.toHaveBeenCalled();
  });

  it("does not execute when busy", async () => {
    let resolveFirst: (() => void) | null = null;
    const executeCode = vi.fn(
      () => new Promise<{ success: true; result: string }>((resolve) => {
        resolveFirst = () => resolve({ success: true, result: "done" });
      })
    );

    renderHook(() =>
      useFigmaExecuteChannel(executeCode, true, {
        type: "figma-plugin",
        label: "Plugin",
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // First request — starts executing (busy = true)
    await act(async () => {
      mockChannel._fireBroadcast("execute_request", {
        requestId: "req-1",
        code: "first",
        timeout: 5000,
      });
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(executeCode).toHaveBeenCalledTimes(1);

    // Second request while first is still running — should be ignored
    await act(async () => {
      mockChannel._fireBroadcast("execute_request", {
        requestId: "req-2",
        code: "second",
        timeout: 5000,
      });
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(executeCode).toHaveBeenCalledTimes(1); // Still 1, second was ignored

    // Resolve first
    await act(async () => {
      resolveFirst?.();
      await vi.advanceTimersByTimeAsync(10);
    });
  });

  it("notifies orchestration workflowId", async () => {
    const onOrch = vi.fn();

    renderHook(() =>
      useFigmaExecuteChannel(noopExecute, true, {
        type: "figma-plugin",
        label: "Plugin",
      }, undefined, onOrch)
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    await act(async () => {
      mockChannel._fireBroadcast("execute_request", {
        requestId: "req-1",
        code: "test",
        timeout: 5000,
        workflowId: "wf-123",
      });
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(onOrch).toHaveBeenCalledWith("wf-123");
  });
});

// ---------------------------------------------------------------------------
// Dead WS / reconnection
// ---------------------------------------------------------------------------

describe("useFigmaExecuteChannel — dead WebSocket detection", () => {
  it("sets reconnecting and clears clients when WS is dead", async () => {
    const { result } = renderHook(() =>
      useFigmaExecuteChannel(noopExecute, true, {
        type: "webapp",
        label: "Test",
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Sync clients
    await act(async () => {
      mockChannel._firePresenceSync({
        "user-123": [
          { presence_ref: "ref-1", clientId: "client-a", type: "webapp", label: "Browser" },
        ],
      });
    });

    expect(result.current.clients).toHaveLength(1);
    expect(result.current.connectionStatus).toBe("connected");

    // Kill WS
    mockChannel.socket.isConnected.mockReturnValue(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.connectionStatus).toBe("reconnecting");
    expect(result.current.clients).toHaveLength(0);
  });

  // Note: re-track throwing is covered by the WS dead detection path.
  // Testing mockRejectedValue inside setInterval + fake timers causes
  // unhandled rejection noise in vitest, so we skip this edge case.
});

// ---------------------------------------------------------------------------
// Subscribe errors
// ---------------------------------------------------------------------------

describe("useFigmaExecuteChannel — subscribe errors", () => {
  it("handles CHANNEL_ERROR without crashing", async () => {
    const { result } = renderHook(() =>
      useFigmaExecuteChannel(noopExecute, true, {
        type: "webapp",
        label: "Test",
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Fire CHANNEL_ERROR
    await act(async () => {
      mockChannel._fireSubscribeStatus("CHANNEL_ERROR");
      await vi.advanceTimersByTimeAsync(10);
    });

    // Should not crash — keepalive will handle reconnect
    expect(result.current.connectionStatus).toBe("connecting");
  });

  it("handles TIMED_OUT without crashing", async () => {
    const { result } = renderHook(() =>
      useFigmaExecuteChannel(noopExecute, true, {
        type: "webapp",
        label: "Test",
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    await act(async () => {
      mockChannel._fireSubscribeStatus("TIMED_OUT");
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.connectionStatus).toBe("connecting");
  });
});

// ---------------------------------------------------------------------------
// Visibility change
// ---------------------------------------------------------------------------

describe("useFigmaExecuteChannel — visibility change", () => {
  it("re-tracks presence and re-syncs when tab becomes visible", async () => {
    renderHook(() =>
      useFigmaExecuteChannel(noopExecute, true, {
        type: "webapp",
        label: "Test",
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Set up presence state
    await act(async () => {
      mockChannel._firePresenceSync({
        "user-123": [
          { presence_ref: "ref-1", clientId: "client-a", type: "webapp", label: "Browser" },
        ],
      });
    });

    mockChannel.track.mockClear();

    // Simulate tab becoming visible
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Should have re-tracked presence
    expect(mockChannel.track).toHaveBeenCalled();
  });

  it("does nothing when tab becomes hidden", async () => {
    const { unmount } = renderHook(() =>
      useFigmaExecuteChannel(noopExecute, true, {
        type: "webapp",
        label: "Test",
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    const callsBefore = mockChannel.track.mock.calls.length;

    // Set hidden AFTER hook is mounted
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
      configurable: true,
    });

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      // Don't advance timers — just let the sync event handler run
    });

    // Visibility handler for "hidden" should NOT trigger additional track calls
    expect(mockChannel.track.mock.calls.length).toBe(callsBefore);

    unmount();
  });
});
