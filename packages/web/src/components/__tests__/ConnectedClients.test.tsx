import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ConnectedClients } from "../ConnectedClients";
import type { PresenceClient } from "@/types/presence";

// ---------------------------------------------------------------------------
// Mock fetch for /api/clients
// ---------------------------------------------------------------------------

let fetchResponse: { clients: unknown[] };

beforeEach(() => {
  fetchResponse = { clients: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(fetchResponse),
      })
    )
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePresenceClient(overrides: Partial<PresenceClient> = {}): PresenceClient {
  return {
    type: "figma-plugin",
    clientId: "client-1",
    shortId: "#A01",
    label: "Figma Plugin",
    connectedAt: Date.now(),
    presenceRef: "ref-1",
    agentRole: "idle",
    ...overrides,
  };
}

function makeDbClient(overrides: Record<string, unknown> = {}) {
  return {
    id: "db-1",
    client_id: "client-1",
    client_type: "figma-plugin",
    short_id: "#A01",
    label: "Figma Plugin",
    file_key: null,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    agent_role: "idle",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConnectedClients — loading state", () => {
  it("shows skeleton placeholders when loading", () => {
    render(<ConnectedClients clients={[]} loading={true} />);
    expect(screen.getByText("Clients")).toBeInTheDocument();
    // Skeleton divs with animate-pulse
    const skeletons = document.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBe(2);
  });

  it("shows connecting badge in skeleton state", () => {
    render(
      <ConnectedClients clients={[]} loading={true} connectionStatus="connecting" />
    );
    expect(screen.getByText("connecting...")).toBeInTheDocument();
  });

  it("shows reconnecting badge in skeleton state", () => {
    render(
      <ConnectedClients clients={[]} loading={true} connectionStatus="reconnecting" />
    );
    expect(screen.getByText("reconnecting...")).toBeInTheDocument();
  });
});

describe("ConnectedClients — connection status badges", () => {
  it("shows connecting badge when status is connecting", async () => {
    fetchResponse = { clients: [] };

    await act(async () => {
      render(
        <ConnectedClients clients={[]} loading={false} connectionStatus="connecting" />
      );
    });

    expect(screen.getByText("connecting...")).toBeInTheDocument();
  });

  it("shows reconnecting badge when status is reconnecting", async () => {
    fetchResponse = { clients: [] };

    await act(async () => {
      render(
        <ConnectedClients clients={[]} loading={false} connectionStatus="reconnecting" />
      );
    });

    expect(screen.getByText("reconnecting...")).toBeInTheDocument();
  });

  it("hides badge when connected", async () => {
    fetchResponse = { clients: [] };

    await act(async () => {
      render(
        <ConnectedClients clients={[]} loading={false} connectionStatus="connected" />
      );
    });

    expect(screen.queryByText("connecting...")).toBeNull();
    expect(screen.queryByText("reconnecting...")).toBeNull();
  });
});

describe("ConnectedClients — merge DB + presence", () => {
  it("shows DB client as online when matched in presence", async () => {
    const dbClient = makeDbClient();
    fetchResponse = { clients: [dbClient] };

    const presenceClient = makePresenceClient();

    await act(async () => {
      render(<ConnectedClients clients={[presenceClient]} loading={false} />);
    });

    // Wait for DB fetch
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screen.getByText("online")).toBeInTheDocument();
  });

  it("shows DB client as offline when not in presence", async () => {
    const dbClient = makeDbClient();
    fetchResponse = { clients: [dbClient] };

    await act(async () => {
      render(<ConnectedClients clients={[]} loading={false} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screen.getByText("offline")).toBeInTheDocument();
  });
});

describe("ConnectedClients — presence-only clients", () => {
  it("shows presence-only client as online even without DB entry", async () => {
    fetchResponse = { clients: [] };

    const presenceClient = makePresenceClient({ clientId: "new-client" });

    await act(async () => {
      render(<ConnectedClients clients={[presenceClient]} loading={false} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screen.getByText("online")).toBeInTheDocument();
  });
});

describe("ConnectedClients — stable ordering", () => {
  it("preserves existing order when new client arrives", async () => {
    fetchResponse = { clients: [] };

    const clientA = makePresenceClient({ clientId: "zzz-client", shortId: "#A01", label: "Plugin A" });
    const clientB = makePresenceClient({ clientId: "aaa-client", shortId: "#A02", label: "Plugin B" });

    // First render with client A
    const { rerender } = render(
      <ConnectedClients clients={[clientA]} loading={false} />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Add client B — should appear after A, not before (despite alphabetical order)
    rerender(
      <ConnectedClients clients={[clientA, clientB]} loading={false} />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const labels = screen.getAllByText(/Plugin [AB]/);
    expect(labels[0].textContent).toContain("Plugin A");
    expect(labels[1].textContent).toContain("Plugin B");
  });
});

describe("ConnectedClients — empty state", () => {
  it("shows empty message when no clients", async () => {
    fetchResponse = { clients: [] };

    await act(async () => {
      render(<ConnectedClients clients={[]} loading={false} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screen.getByText("No clients registered")).toBeInTheDocument();
  });
});

describe("ConnectedClients — client leaves presence (offline transition)", () => {
  it("presence-only client transitions to offline instead of disappearing", async () => {
    fetchResponse = { clients: [] };

    const client = makePresenceClient({ clientId: "ephemeral-1", shortId: "#E01", label: "Ephemeral Plugin" });

    // Render with client online
    const { rerender } = render(
      <ConnectedClients clients={[client]} loading={false} />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screen.getByText("online")).toBeInTheDocument();
    expect(screen.getByText("Ephemeral Plugin")).toBeInTheDocument();

    // Client leaves presence — rerender with empty presence list
    // DB re-fetch still returns empty (client never registered in DB)
    fetchResponse = { clients: [] };

    rerender(
      <ConnectedClients clients={[]} loading={false} />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Client should still be visible, but now as offline (cached)
    expect(screen.getByText("Ephemeral Plugin")).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  it("re-fetches DB when a presence client disappears", async () => {
    const dbClient = makeDbClient({ client_id: "db-client-1", short_id: "#D01", label: "DB Plugin" });
    fetchResponse = { clients: [dbClient] };

    const presenceClient = makePresenceClient({ clientId: "db-client-1", shortId: "#D01", label: "DB Plugin" });

    // Render with client online
    const { rerender } = render(
      <ConnectedClients clients={[presenceClient]} loading={false} />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screen.getByText("online")).toBeInTheDocument();

    // Clear fetch mock to track new calls
    (fetch as ReturnType<typeof vi.fn>).mockClear();

    // Client leaves presence
    rerender(
      <ConnectedClients clients={[]} loading={false} />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should have triggered a re-fetch of /api/clients
    expect(fetch).toHaveBeenCalledWith("/api/clients");
  });
});

describe("ConnectedClients — full lifecycle: arrive at bottom, disconnect in place", () => {
  it("new client appears at bottom, then transitions to offline without moving", async () => {
    fetchResponse = { clients: [] };

    const existing = makePresenceClient({ clientId: "existing-1", shortId: "#E01", label: "Existing-Client" });

    // Step 1: render with one existing client
    const { rerender } = render(
      <ConnectedClients clients={[existing]} loading={false} />
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    expect(screen.getByText("Existing-Client")).toBeInTheDocument();

    // Step 2: new client arrives — should appear at bottom
    const newcomer = makePresenceClient({ clientId: "newcomer-1", shortId: "#N01", label: "Newcomer-Client" });
    rerender(
      <ConnectedClients clients={[existing, newcomer]} loading={false} />
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    let body = document.body.textContent ?? "";
    expect(body.indexOf("Existing-Client")).toBeLessThan(body.indexOf("Newcomer-Client"));
    expect(screen.getAllByText("online")).toHaveLength(2);

    // Step 3: newcomer disconnects — should stay in same position but go offline
    rerender(
      <ConnectedClients clients={[existing]} loading={false} />
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    // Newcomer still visible
    expect(screen.getByText("Newcomer-Client")).toBeInTheDocument();
    // Still in same order (existing first, newcomer second)
    body = document.body.textContent ?? "";
    expect(body.indexOf("Existing-Client")).toBeLessThan(body.indexOf("Newcomer-Client"));
    // Existing is online, newcomer is offline
    expect(screen.getByText("online")).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();
  });
});

describe("ConnectedClients — order never changes for existing clients", () => {
  it("existing clients keep their position through multiple joins, leaves, and status changes", async () => {
    fetchResponse = { clients: [] };

    const a = makePresenceClient({ clientId: "aaa", shortId: "#A", label: "Client-A" });
    const b = makePresenceClient({ clientId: "bbb", shortId: "#B", label: "Client-B" });
    const c = makePresenceClient({ clientId: "ccc", shortId: "#C", label: "Client-C" });

    const getOrder = () => {
      const text = document.body.textContent ?? "";
      const positions = ["Client-A", "Client-B", "Client-C"]
        .map((l) => ({ label: l, idx: text.indexOf(l) }))
        .filter((p) => p.idx >= 0)
        .sort((x, y) => x.idx - y.idx)
        .map((p) => p.label);
      return positions;
    };

    // Step 1: A, B, C all join
    const { rerender } = render(
      <ConnectedClients clients={[a, b, c]} loading={false} />
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const initialOrder = getOrder();
    expect(initialOrder).toHaveLength(3);

    // Step 2: B leaves — A and C keep their relative order, B goes offline in place
    rerender(<ConnectedClients clients={[a, c]} loading={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const afterBLeaves = getOrder();
    expect(afterBLeaves).toEqual(initialOrder); // all 3 still visible, same order

    // Step 3: B comes back online
    rerender(<ConnectedClients clients={[a, b, c]} loading={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(getOrder()).toEqual(initialOrder);

    // Step 4: A leaves
    rerender(<ConnectedClients clients={[b, c]} loading={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(getOrder()).toEqual(initialOrder);

    // Step 5: new client D joins — appends at end, others don't move
    const d = makePresenceClient({ clientId: "ddd", shortId: "#D", label: "Client-D" });
    rerender(<ConnectedClients clients={[b, c, d]} loading={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const withD = getOrder();
    // A, B, C still in same relative order
    expect(withD.slice(0, 3)).toEqual(initialOrder);
    // D appended at end
    expect(document.body.textContent).toContain("Client-D");
    const text = document.body.textContent ?? "";
    const lastOriginal = Math.max(...initialOrder.map((l) => text.indexOf(l)));
    expect(text.indexOf("Client-D")).toBeGreaterThan(lastOriginal);

    // Step 6: everyone leaves — all show as offline, order preserved
    rerender(<ConnectedClients clients={[]} loading={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const allOffline = getOrder();
    expect(allOffline.slice(0, 3)).toEqual(initialOrder);
  });
});

describe("ConnectedClients — alternating types then F5 resets order", () => {
  it("mixed webapp/plugin arrivals append at end, F5 resets to clientId order", async () => {
    fetchResponse = { clients: [] };

    const plugin1 = makePresenceClient({ clientId: "ppp-1", type: "figma-plugin", shortId: "#P1", label: "Plugin-1" });
    const webapp1 = makePresenceClient({ clientId: "www-1", type: "webapp", shortId: "#W1", label: "Webapp-1" });
    const plugin2 = makePresenceClient({ clientId: "ppp-2", type: "figma-plugin", shortId: "#P2", label: "Plugin-2" });
    const webapp2 = makePresenceClient({ clientId: "www-2", type: "webapp", shortId: "#W2", label: "Webapp-2" });

    const getOrder = () => {
      const text = document.body.textContent ?? "";
      return ["Plugin-1", "Webapp-1", "Plugin-2", "Webapp-2"]
        .map((l) => ({ label: l, idx: text.indexOf(l) }))
        .filter((p) => p.idx >= 0)
        .sort((x, y) => x.idx - y.idx)
        .map((p) => p.label);
    };

    // Step 1: Plugin-1 arrives first
    const { rerender, unmount } = render(
      <ConnectedClients clients={[plugin1]} loading={false} />
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(getOrder()).toEqual(["Plugin-1"]);

    // Step 2: Webapp-1 arrives — appends at end
    rerender(<ConnectedClients clients={[plugin1, webapp1]} loading={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(getOrder()).toEqual(["Plugin-1", "Webapp-1"]);

    // Step 3: Plugin-2 arrives — appends at end
    rerender(<ConnectedClients clients={[plugin1, webapp1, plugin2]} loading={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(getOrder()).toEqual(["Plugin-1", "Webapp-1", "Plugin-2"]);

    // Step 4: Webapp-2 arrives — appends at end
    const allClients = [plugin1, webapp1, plugin2, webapp2];
    rerender(<ConnectedClients clients={allClients} loading={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    // Order is arrival order, NOT alphabetical
    expect(getOrder()).toEqual(["Plugin-1", "Webapp-1", "Plugin-2", "Webapp-2"]);

    // Step 5: Simulate F5 — unmount and remount from scratch
    unmount();
    fetchResponse = { clients: [] };
    render(<ConnectedClients clients={allClients} loading={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    // After F5, order resets to clientId alphabetical: ppp-1, ppp-2, www-1, www-2
    expect(getOrder()).toEqual(["Plugin-1", "Plugin-2", "Webapp-1", "Webapp-2"]);
  });
});

describe("ConnectedClients — type icons and labels", () => {
  it("shows correct icon and label for figma-plugin", async () => {
    fetchResponse = { clients: [] };
    const client = makePresenceClient({ type: "figma-plugin", label: "My Plugin" });

    await act(async () => {
      render(<ConnectedClients clients={[client]} loading={false} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    expect(screen.getByText("F")).toBeInTheDocument(); // typeIcon
    expect(screen.getByText("Figma Plugin")).toBeInTheDocument(); // typeLabel
  });

  it("shows correct icon and label for webapp", async () => {
    fetchResponse = { clients: [] };
    const client = makePresenceClient({ type: "webapp", clientId: "w1", label: "Safari" });

    await act(async () => {
      render(<ConnectedClients clients={[client]} loading={false} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    expect(screen.getByText("W")).toBeInTheDocument();
    expect(screen.getByText("Webapp")).toBeInTheDocument();
  });

  it("shows correct icon and label for overlay", async () => {
    fetchResponse = { clients: [] };
    const client = makePresenceClient({ type: "overlay" as "figma-plugin", clientId: "o1", label: "My Overlay" });

    await act(async () => {
      render(<ConnectedClients clients={[client]} loading={false} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    expect(screen.getByText("O")).toBeInTheDocument();
    expect(screen.getByText("Overlay")).toBeInTheDocument(); // typeLabel
    expect(screen.getByText("My Overlay")).toBeInTheDocument(); // label
  });
});

describe("ConnectedClients — MCP and Figma context display", () => {
  it("shows MCP sub-info for online clients", async () => {
    fetchResponse = { clients: [] };
    const client = makePresenceClient({
      clientId: "mcp-1",
      label: "MCP Plugin",
      mcpInfo: {
        figma: { connected: true, mode: "local" },
        code: { connected: true, path: "/home/user/project" },
      },
    });

    await act(async () => {
      render(<ConnectedClients clients={[client]} loading={false} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    expect(screen.getByText("Figma MCP: local")).toBeInTheDocument();
    expect(screen.getByText("Code MCP: /home/user/project")).toBeInTheDocument();
  });

  it("shows figma context filename", async () => {
    fetchResponse = { clients: [] };
    const client = makePresenceClient({
      clientId: "ctx-1",
      label: "Figma With Context",
      figmaContext: {
        fileName: "Design System v2",
      },
    });

    await act(async () => {
      render(<ConnectedClients clients={[client]} loading={false} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    expect(screen.getByText("Design System v2")).toBeInTheDocument();
  });

  it("shows truncated fileKey when no figmaContext fileName", async () => {
    fetchResponse = { clients: [] };
    const client = makePresenceClient({
      clientId: "fk-1",
      label: "Plugin No Context",
      fileKey: "abcdefghijklmnop",
    });

    await act(async () => {
      render(<ConnectedClients clients={[client]} loading={false} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    expect(screen.getByText("File: abcdefgh...")).toBeInTheDocument();
  });
});

describe("ConnectedClients — stable ordering on new arrivals", () => {
  it("new client appends at end without moving existing clients", async () => {
    fetchResponse = { clients: [] };

    const clientA = makePresenceClient({ clientId: "zzz", shortId: "#A01", label: "Alpha-One" });

    // Render with one client
    const { rerender } = render(
      <ConnectedClients clients={[clientA]} loading={false} />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screen.getByText("Alpha-One")).toBeInTheDocument();

    // Add a second client with an alphabetically earlier ID
    const clientB = makePresenceClient({ clientId: "aaa", shortId: "#A02", label: "Beta-Two" });

    rerender(
      <ConnectedClients clients={[clientA, clientB]} loading={false} />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Both visible
    const alphaEl = screen.getByText("Alpha-One");
    const betaEl = screen.getByText("Beta-Two");

    // Alpha-One (zzz, already displayed) should come before Beta-Two (aaa, newcomer)
    // despite aaa < zzz alphabetically — newcomers append at end
    const allText = document.body.textContent ?? "";
    const alphaIdx = allText.indexOf("Alpha-One");
    const betaIdx = allText.indexOf("Beta-Two");
    expect(alphaIdx).toBeLessThan(betaIdx);
    expect(alphaEl).toBeInTheDocument();
    expect(betaEl).toBeInTheDocument();
  });
});
