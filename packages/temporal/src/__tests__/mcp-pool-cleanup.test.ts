/**
 * Tests for MCP stdio subprocess pool cleanup.
 *
 * Verifies that subprocesses are properly killed in all shutdown scenarios:
 * - explicit closeStdioPool
 * - killPoolEntry with real PID
 * - pool filtering by agentId
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { closeStdioPool, _testing } from "../activities/mcp.js";

const { stdioPool, killPoolEntry } = _testing;

/** Spawn a real `sleep` process and return its PID. */
function spawnSleepProcess(): ChildProcess {
  const child = spawn("sleep", ["300"], { stdio: "ignore", detached: false });
  return child;
}

/** Check if a PID is alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

/** Wait for a PID to die (max 2s). */
async function waitForDeath(pid: number, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

// Clean up pool between tests
beforeEach(() => {
  stdioPool.clear();
});

// Safety: kill any leftover test processes
const testProcesses: ChildProcess[] = [];
afterEach(() => {
  for (const child of testProcesses) {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }
  testProcesses.length = 0;
  stdioPool.clear();
});

describe("killPoolEntry", () => {
  it("kills subprocess by PID", async () => {
    const child = spawnSleepProcess();
    testProcesses.push(child);
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);

    const mockClient = { close: () => {} };
    const entry = { client: mockClient, tools: {}, lastUsed: Date.now(), pid };
    stdioPool.set("test:agent-1", entry);

    killPoolEntry("test:agent-1", entry);

    expect(await waitForDeath(pid)).toBe(true);
    expect(stdioPool.has("test:agent-1")).toBe(false);
  });

  it("handles already-dead PID gracefully", () => {
    const mockClient = { close: () => {} };
    const entry = { client: mockClient, tools: {}, lastUsed: Date.now(), pid: 999999 };
    stdioPool.set("test:dead", entry);

    // Should not throw
    killPoolEntry("test:dead", entry);
    expect(stdioPool.has("test:dead")).toBe(false);
  });

  it("handles missing PID gracefully", () => {
    const mockClient = { close: () => {} };
    const entry = { client: mockClient, tools: {}, lastUsed: Date.now() };
    stdioPool.set("test:no-pid", entry);

    killPoolEntry("test:no-pid", entry);
    expect(stdioPool.has("test:no-pid")).toBe(false);
  });

  it("calls client.close() even if kill fails", () => {
    let closeCalled = false;
    const mockClient = { close: () => { closeCalled = true; } };
    const entry = { client: mockClient, tools: {}, lastUsed: Date.now(), pid: 999999 };
    stdioPool.set("test:close", entry);

    killPoolEntry("test:close", entry);
    expect(closeCalled).toBe(true);
  });
});

describe("closeStdioPool", () => {
  it("kills all subprocesses when no agentId filter", async () => {
    const child1 = spawnSleepProcess();
    const child2 = spawnSleepProcess();
    testProcesses.push(child1, child2);

    const mockClient = { close: () => {} };
    stdioPool.set("server:agent-1", { client: mockClient, tools: {}, lastUsed: Date.now(), pid: child1.pid! });
    stdioPool.set("server:agent-2", { client: mockClient, tools: {}, lastUsed: Date.now(), pid: child2.pid! });

    expect(stdioPool.size).toBe(2);

    await closeStdioPool({});

    expect(stdioPool.size).toBe(0);
    expect(await waitForDeath(child1.pid!)).toBe(true);
    expect(await waitForDeath(child2.pid!)).toBe(true);
  });

  it("kills only matching agent when agentId filter provided", async () => {
    const child1 = spawnSleepProcess();
    const child2 = spawnSleepProcess();
    testProcesses.push(child1, child2);

    const mockClient = { close: () => {} };
    stdioPool.set("server:agent-1", { client: mockClient, tools: {}, lastUsed: Date.now(), pid: child1.pid! });
    stdioPool.set("server:agent-2", { client: mockClient, tools: {}, lastUsed: Date.now(), pid: child2.pid! });

    await closeStdioPool({ agentId: "agent-1" });

    expect(stdioPool.size).toBe(1);
    expect(await waitForDeath(child1.pid!)).toBe(true);
    expect(isAlive(child2.pid!)).toBe(true);
    expect(stdioPool.has("server:agent-2")).toBe(true);
  });
});
