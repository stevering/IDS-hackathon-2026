import { describe, it, expect } from "vitest";
import {
  parseDirectives,
  parseAgentDoneMarkers,
  parseOrchestrateMarker,
} from "../logic/directive-parser.js";

describe("parseDirectives", () => {
  it("parses structured DIRECTIVE blocks", () => {
    const input = `Here is the plan:

[DIRECTIVE:#figma-1]
Create a button component with primary and secondary variants.
[/DIRECTIVE]

[DIRECTIVE:#figma-2]
Update the color tokens to match the new brand palette.
[/DIRECTIVE]`;

    const result = parseDirectives(input);
    expect(result).toHaveLength(2);
    expect(result[0].agentShortId).toBe("figma-1");
    expect(result[0].content).toBe(
      "Create a button component with primary and secondary variants."
    );
    expect(result[1].agentShortId).toBe("figma-2");
    expect(result[1].content).toBe(
      "Update the color tokens to match the new brand palette."
    );
  });

  it("parses multi-line directive content", () => {
    const input = `[DIRECTIVE:#agent-a]
Step 1: Do this
Step 2: Do that
Step 3: Verify
[/DIRECTIVE]`;

    const result = parseDirectives(input);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("Step 1");
    expect(result[0].content).toContain("Step 3");
  });

  it("falls back to [TO:#id] format when no DIRECTIVE blocks", () => {
    const input = `[TO:#figma-1] Create a button component
[TO:#figma-2] Update the colors`;

    const result = parseDirectives(input);
    expect(result).toHaveLength(2);
    expect(result[0].agentShortId).toBe("figma-1");
    expect(result[0].content).toBe("Create a button component");
    expect(result[1].agentShortId).toBe("figma-2");
    expect(result[1].content).toBe("Update the colors");
  });

  it("returns empty array when no directives found", () => {
    const result = parseDirectives("No directives here, just regular text.");
    expect(result).toHaveLength(0);
  });

  it("handles whitespace in agent IDs", () => {
    const input = `[DIRECTIVE:# figma-1 ]
Do something
[/DIRECTIVE]`;

    const result = parseDirectives(input);
    expect(result).toHaveLength(1);
    expect(result[0].agentShortId).toBe("figma-1");
  });
});

describe("parseAgentDoneMarkers", () => {
  it("parses single AGENT_DONE marker", () => {
    const result = parseAgentDoneMarkers(
      "Great work! [AGENT_DONE:#figma-1] Your task is complete."
    );
    expect(result).toEqual(["figma-1"]);
  });

  it("parses multiple AGENT_DONE markers", () => {
    const result = parseAgentDoneMarkers(
      "[AGENT_DONE:#figma-1] [AGENT_DONE:#figma-2] Both done!"
    );
    expect(result).toEqual(["figma-1", "figma-2"]);
  });

  it("returns empty array when no markers", () => {
    const result = parseAgentDoneMarkers("No markers here");
    expect(result).toEqual([]);
  });

  it("trims whitespace in IDs", () => {
    const result = parseAgentDoneMarkers("[AGENT_DONE:# figma-1 ]");
    expect(result).toEqual(["figma-1"]);
  });
});

describe("parseOrchestrateMarker", () => {
  it("parses ORCHESTRATE marker with multiple agents", () => {
    const result = parseOrchestrateMarker(
      "Let me coordinate. [ORCHESTRATE:#figma-1,#figma-2]"
    );
    expect(result).toEqual(["figma-1", "figma-2"]);
  });

  it("parses single agent", () => {
    const result = parseOrchestrateMarker("[ORCHESTRATE:#agent-1]");
    expect(result).toEqual(["agent-1"]);
  });

  it("returns null when no marker", () => {
    const result = parseOrchestrateMarker("No orchestrate marker here");
    expect(result).toBeNull();
  });

  it("strips # prefix from results", () => {
    const result = parseOrchestrateMarker("[ORCHESTRATE:#a,#b,#c]");
    expect(result).toEqual(["a", "b", "c"]);
  });
});
