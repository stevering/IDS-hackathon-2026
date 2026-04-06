/**
 * Tests for the Guardian Bridge client (callBridgedMCP).
 *
 * Uses a mock Supabase Realtime channel to verify:
 *   - Request published with correct shape and channel name
 *   - Response correlation by requestId
 *   - Timeout path returns structured error
 *   - Bridge error path propagates the error message
 *   - Unrelated responses (wrong requestId) are ignored
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { callBridgedMCP, type CallBridgedMCPParams } from "../activities/mcp-bridge-client.js";
import { MCP_REQUEST_EVENT, MCP_RESPONSE_EVENT } from "@guardian/orchestrations";

// ---------------------------------------------------------------------------
// Mock Supabase Realtime channel
// ---------------------------------------------------------------------------

type BroadcastHandler = (msg: { payload: unknown }) => void;

function createMockChannel() {
  const handlers: Array<{ event: string; fn: BroadcastHandler }> = [];
  let subscribeCb: ((status: string) => void) | null = null;
  const sent: Array<{ type: string; event: string; payload: unknown }> = [];

  const channel = {
    on(
      _kind: string,
      opts: { event: string },
      fn: BroadcastHandler,
    ) {
      handlers.push({ event: opts.event, fn });
      return channel;
    },

    subscribe(cb: (status: string) => void) {
      subscribeCb = cb;
      // Auto-subscribe immediately (simulates a fast connection)
      queueMicrotask(() => cb("SUBSCRIBED"));
      return channel;
    },

    send(msg: { type: string; event: string; payload: unknown }) {
      sent.push(msg);
      return channel;
    },

    unsubscribe() {
      return channel;
    },

    /** Test helper: simulate an incoming broadcast from the overlay. */
    _simulateIncoming(event: string, payload: unknown) {
      for (const h of handlers) {
        if (h.event === event) {
          h.fn({ payload });
        }
      }
    },

    /** Test helper: get all sent messages. */
    _sent: sent,

    /** Test helper: get the subscribe callback. */
    get _subscribeCb() {
      return subscribeCb;
    },
  };

  return channel;
}

function createMockSupabase(channel: ReturnType<typeof createMockChannel>) {
  return {
    channel: vi.fn().mockReturnValue(channel),
    // Minimal SupabaseClient shape to satisfy the type
    auth: {} as never,
    from: vi.fn() as never,
    rpc: vi.fn() as never,
    functions: {} as never,
    storage: {} as never,
    realtime: {} as never,
    rest: {} as never,
    schema: vi.fn() as never,
    removeAllChannels: vi.fn() as never,
    removeChannel: vi.fn() as never,
    getChannels: vi.fn() as never,
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const BASE_PARAMS: Omit<CallBridgedMCPParams, "_supabaseClient"> = {
  userId: "user-aaa",
  deviceId: "device-bbb",
  instanceId: "instance-ccc",
  method: "tools/list",
  timeoutMs: 500, // short for tests
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callBridgedMCP", () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSupabase: any;

  beforeEach(() => {
    mockChannel = createMockChannel();
    mockSupabase = createMockSupabase(mockChannel);
  });

  it("publishes a well-formed mcp-request on the correct channel", async () => {
    // Simulate an immediate OK response for every request
    const originalSend = mockChannel.send.bind(mockChannel);
    mockChannel.send = (msg) => {
      originalSend(msg);
      if (msg.event === MCP_REQUEST_EVENT) {
        const req = msg.payload as { requestId: string };
        queueMicrotask(() => {
          mockChannel._simulateIncoming(MCP_RESPONSE_EVENT, {
            type: "mcp-response",
            requestId: req.requestId,
            ok: true,
            result: { tools: [] },
          });
        });
      }
      return mockChannel;
    };

    const result = await callBridgedMCP({
      ...BASE_PARAMS,
      _supabaseClient: mockSupabase,
    });

    // Channel name scoped to userId:deviceId
    expect(mockSupabase.channel).toHaveBeenCalledWith(
      "guardian:mcp:user-aaa:device-bbb",
    );

    // A request was sent
    expect(mockChannel._sent).toHaveLength(1);
    const sent = mockChannel._sent[0];
    expect(sent.type).toBe("broadcast");
    expect(sent.event).toBe(MCP_REQUEST_EVENT);

    const payload = sent.payload as Record<string, unknown>;
    expect(payload.type).toBe("mcp-request");
    expect(payload.targetDeviceId).toBe("device-bbb");
    expect(payload.instanceId).toBe("instance-ccc");
    expect(payload.method).toBe("tools/list");
    expect(typeof payload.requestId).toBe("string");
    expect(typeof payload.deadline).toBe("number");

    // Result is OK
    expect(result).toEqual({ ok: true, result: { tools: [] } });
  });

  it("correlates response by requestId", async () => {
    // Simulate two responses: one with wrong ID, one with correct ID
    const originalSend = mockChannel.send.bind(mockChannel);
    mockChannel.send = (msg) => {
      originalSend(msg);
      if (msg.event === MCP_REQUEST_EVENT) {
        const req = msg.payload as { requestId: string };
        queueMicrotask(() => {
          // Wrong requestId first
          mockChannel._simulateIncoming(MCP_RESPONSE_EVENT, {
            requestId: "wrong-id",
            ok: true,
            result: "should be ignored",
          });
          // Correct requestId
          mockChannel._simulateIncoming(MCP_RESPONSE_EVENT, {
            requestId: req.requestId,
            ok: true,
            result: "correct",
          });
        });
      }
      return mockChannel;
    };

    const result = await callBridgedMCP({
      ...BASE_PARAMS,
      _supabaseClient: mockSupabase,
    });

    expect(result).toEqual({ ok: true, result: "correct" });
  });

  it("returns structured error on timeout", async () => {
    // No response simulated → timeout after 500ms
    const result = await callBridgedMCP({
      ...BASE_PARAMS,
      timeoutMs: 100,
      _supabaseClient: mockSupabase,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Bridge timeout");
      expect(result.error).toContain("100ms");
    }
  });

  it("propagates bridge error from overlay response", async () => {
    const originalSend = mockChannel.send.bind(mockChannel);
    mockChannel.send = (msg) => {
      originalSend(msg);
      if (msg.event === MCP_REQUEST_EVENT) {
        const req = msg.payload as { requestId: string };
        queueMicrotask(() => {
          mockChannel._simulateIncoming(MCP_RESPONSE_EVENT, {
            requestId: req.requestId,
            ok: false,
            error: "Figma Desktop is not running",
          });
        });
      }
      return mockChannel;
    };

    const result = await callBridgedMCP({
      ...BASE_PARAMS,
      _supabaseClient: mockSupabase,
    });

    expect(result).toEqual({
      ok: false,
      error: "Figma Desktop is not running",
    });
  });

  it("passes tool call params correctly", async () => {
    const originalSend = mockChannel.send.bind(mockChannel);
    mockChannel.send = (msg) => {
      originalSend(msg);
      if (msg.event === MCP_REQUEST_EVENT) {
        const req = msg.payload as { requestId: string };
        queueMicrotask(() => {
          mockChannel._simulateIncoming(MCP_RESPONSE_EVENT, {
            requestId: req.requestId,
            ok: true,
            result: { nodeId: "123" },
          });
        });
      }
      return mockChannel;
    };

    await callBridgedMCP({
      ...BASE_PARAMS,
      method: "tools/call",
      params: { name: "get_selection", arguments: { depth: 2 } },
      _supabaseClient: mockSupabase,
    });

    const payload = mockChannel._sent[0].payload as Record<string, unknown>;
    expect(payload.method).toBe("tools/call");
    expect(payload.params).toEqual({
      name: "get_selection",
      arguments: { depth: 2 },
    });
  });

  it("handles channel subscription failure", async () => {
    // Override subscribe to report CHANNEL_ERROR
    mockChannel.subscribe = (cb: (status: string) => void) => {
      queueMicrotask(() => cb("CHANNEL_ERROR"));
      return mockChannel;
    };

    const result = await callBridgedMCP({
      ...BASE_PARAMS,
      _supabaseClient: mockSupabase,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("CHANNEL_ERROR");
    }
  });
});
