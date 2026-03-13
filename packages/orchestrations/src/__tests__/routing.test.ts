import { describe, it, expect } from "vitest";
import {
  resolveTargetWorkflowId,
  resolveBroadcastTargets,
  validatePeerTarget,
} from "../engine/routing.js";
import type { AgentId } from "../types/signals.js";

function makeDirectory(): Map<string, AgentId> {
  const dir = new Map<string, AgentId>();
  dir.set("a", {
    shortId: "a",
    workflowId: "wf-a",
    label: "Agent A",
    type: "figma-plugin",
  });
  dir.set("b", {
    shortId: "b",
    workflowId: "wf-b",
    label: "Agent B",
    type: "figma-plugin",
  });
  dir.set("c", {
    shortId: "c",
    workflowId: "wf-c",
    label: "Agent C",
    type: "web",
  });
  return dir;
}

describe("resolveTargetWorkflowId", () => {
  it("returns workflow ID for known agent", () => {
    const dir = makeDirectory();
    expect(resolveTargetWorkflowId(dir, "a")).toBe("wf-a");
    expect(resolveTargetWorkflowId(dir, "b")).toBe("wf-b");
  });

  it("returns null for unknown agent", () => {
    const dir = makeDirectory();
    expect(resolveTargetWorkflowId(dir, "unknown")).toBeNull();
  });
});

describe("resolveBroadcastTargets", () => {
  it("returns all workflow IDs except excluded", () => {
    const dir = makeDirectory();
    const targets = resolveBroadcastTargets(dir, ["a"]);
    expect(targets).toHaveLength(2);
    expect(targets).toContain("wf-b");
    expect(targets).toContain("wf-c");
    expect(targets).not.toContain("wf-a");
  });

  it("returns all when nothing excluded", () => {
    const dir = makeDirectory();
    const targets = resolveBroadcastTargets(dir, []);
    expect(targets).toHaveLength(3);
  });

  it("returns empty when all excluded", () => {
    const dir = makeDirectory();
    const targets = resolveBroadcastTargets(dir, ["a", "b", "c"]);
    expect(targets).toHaveLength(0);
  });
});

describe("validatePeerTarget", () => {
  it("validates known agent", () => {
    const dir = makeDirectory();
    expect(validatePeerTarget(dir, "a").valid).toBe(true);
  });

  it("rejects unknown agent", () => {
    const dir = makeDirectory();
    const result = validatePeerTarget(dir, "unknown");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("rejects agent without workflow ID", () => {
    const dir = makeDirectory();
    dir.set("d", {
      shortId: "d",
      workflowId: "",
      label: "Agent D",
      type: "figma-plugin",
    });

    const result = validatePeerTarget(dir, "d");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("no workflow ID");
  });
});
