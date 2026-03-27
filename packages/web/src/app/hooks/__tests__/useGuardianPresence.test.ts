import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock Supabase channel
// ---------------------------------------------------------------------------

type PresenceHandler = () => void;
type SubscribeCallback = (status: string) => void;

class MockChannel {
  private presenceHandlers: PresenceHandler[] = [];
  private subscribeCallback: SubscribeCallback | null = null;
  private _presenceState: Record<string, unknown[]> = {};

  track = vi.fn(async () => {});
  unsubscribe = vi.fn();
  send = vi.fn();
  socket = { isConnected: vi.fn(() => true) };

  on(type: string, _filter: { event: string }, handler: unknown) {
    if (type === "presence") {
      this.presenceHandlers.push(handler as PresenceHandler);
    }
    return this;
  }

  subscribe(cb?: SubscribeCallback) {
    this.subscribeCallback = cb ?? null;
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
      h();
    }
  }
}

let mockChannel: MockChannel;
let mockGetUser: ReturnType<typeof vi.fn>;

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: (_name: string) => {
      mockChannel = new MockChannel();
      return mockChannel;
    },
    auth: {
      getUser: () => mockGetUser(),
    },
  }),
}));

// Must import after mock
import { useGuardianPresence } from "../useGuardianPresence";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockGetUser = vi.fn(() =>
    Promise.resolve({ data: { user: { id: "user-123" } } })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useGuardianPresence — initial state", () => {
  it("starts with loading=true and connecting status", () => {
    const { result } = renderHook(() => useGuardianPresence());

    expect(result.current.loading).toBe(true);
    expect(result.current.connectionStatus).toBe("connecting");
    expect(result.current.clients).toEqual([]);
  });
});

describe("useGuardianPresence — presence sync", () => {
  it("updates clients and sets connected on sync", async () => {
    const { result } = renderHook(() => useGuardianPresence());

    // Wait for auth
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Fire sync
    await act(async () => {
      mockChannel._firePresenceSync({
        "user-123": [
          { presence_ref: "ref-1", clientId: "client-a", type: "figma-plugin", label: "Plugin" },
        ],
      });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.connectionStatus).toBe("connected");
    expect(result.current.clients).toHaveLength(1);
    expect(result.current.clients[0].clientId).toBe("client-a");
  });

  it("updates when clients join and leave", async () => {
    const { result } = renderHook(() => useGuardianPresence());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Two clients
    await act(async () => {
      mockChannel._firePresenceSync({
        "user-123": [
          { presence_ref: "ref-1", clientId: "client-a", type: "figma-plugin", label: "Plugin A" },
          { presence_ref: "ref-2", clientId: "client-b", type: "webapp", label: "Browser" },
        ],
      });
    });

    expect(result.current.clients).toHaveLength(2);

    // One leaves
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

describe("useGuardianPresence — fallback timeout", () => {
  it("ends loading after 5s even without sync", async () => {
    const { result } = renderHook(() => useGuardianPresence());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.loading).toBe(true);

    // Advance past 5s timeout
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.connectionStatus).toBe("connected");
    // No fake clients
    expect(result.current.clients).toEqual([]);
  });

  it("does not fire fallback if sync arrives first", async () => {
    const { result } = renderHook(() => useGuardianPresence());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Sync at 2s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      mockChannel._firePresenceSync({
        "user-123": [
          { presence_ref: "ref-1", clientId: "client-a", type: "webapp", label: "Browser" },
        ],
      });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.clients).toHaveLength(1);

    // Advance past timeout — nothing changes
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.clients).toHaveLength(1);
  });
});

describe("useGuardianPresence — unauthenticated", () => {
  it("sets loading=false and connected when no user", async () => {
    mockGetUser = vi.fn(() =>
      Promise.resolve({ data: { user: null } })
    );

    const { result } = renderHook(() => useGuardianPresence());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.connectionStatus).toBe("connected");
    expect(result.current.clients).toEqual([]);
  });
});

describe("useGuardianPresence — dead WebSocket detection", () => {
  it("sets reconnecting and clears clients when WS is dead", async () => {
    const { result } = renderHook(() => useGuardianPresence());

    // Wait for auth + subscribe
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Sync with a client
    await act(async () => {
      mockChannel._firePresenceSync({
        "user-123": [
          { presence_ref: "ref-1", clientId: "client-a", type: "figma-plugin", label: "Plugin" },
        ],
      });
    });

    expect(result.current.clients).toHaveLength(1);
    expect(result.current.connectionStatus).toBe("connected");

    // Simulate dead WS — socket.isConnected() returns false
    mockChannel.socket.isConnected.mockReturnValue(false);

    // Advance 10s — keepalive fires and detects dead WS
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.connectionStatus).toBe("reconnecting");
    expect(result.current.clients).toHaveLength(0);
  });

  it("recovers after reconnect (new channel syncs)", async () => {
    const { result } = renderHook(() => useGuardianPresence());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Initial sync
    await act(async () => {
      mockChannel._firePresenceSync({
        "user-123": [
          { presence_ref: "ref-1", clientId: "client-a", type: "figma-plugin", label: "Plugin" },
        ],
      });
    });

    expect(result.current.clients).toHaveLength(1);

    // Kill WS
    mockChannel.socket.isConnected.mockReturnValue(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.connectionStatus).toBe("reconnecting");
    expect(result.current.clients).toHaveLength(0);

    // reconnectKey changed → useEffect re-runs → new channel created
    // Wait for new auth + subscribe
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // New channel syncs with clients
    await act(async () => {
      mockChannel._firePresenceSync({
        "user-123": [
          { presence_ref: "ref-2", clientId: "client-b", type: "webapp", label: "Browser" },
        ],
      });
    });

    expect(result.current.connectionStatus).toBe("connected");
    expect(result.current.clients).toHaveLength(1);
    expect(result.current.clients[0].clientId).toBe("client-b");
  });
});

describe("useGuardianPresence — debug helper", () => {
  it("exposes forceReconnect on window", async () => {
    renderHook(() => useGuardianPresence());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    const debug = (window as unknown as Record<string, unknown>).__guardianPresenceDebug as {
      forceReconnect: () => void;
      getStatus: () => { connectionStatus: string };
    };

    expect(debug).toBeDefined();
    expect(typeof debug.forceReconnect).toBe("function");
    expect(typeof debug.getStatus).toBe("function");
  });
});
