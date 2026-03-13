/**
 * Directive and marker parser for orchestrator LLM responses.
 *
 * Extracts structured directives and completion markers from
 * the orchestrator's natural language output.
 */

// ---------------------------------------------------------------------------
// Parsed directive
// ---------------------------------------------------------------------------

export type ParsedDirective = {
  agentShortId: string;
  content: string;
  expectedResult?: string;
};

// ---------------------------------------------------------------------------
// Parse [DIRECTIVE:#agentId] ... [/DIRECTIVE] blocks
// ---------------------------------------------------------------------------

const DIRECTIVE_REGEX = /\[DIRECTIVE:#([^\]]+)\]\s*([\s\S]*?)\s*\[\/DIRECTIVE\]/g;

export function parseDirectives(llmResponse: string): ParsedDirective[] {
  const directives: ParsedDirective[] = [];
  let match: RegExpExecArray | null;

  // Reset regex lastIndex
  DIRECTIVE_REGEX.lastIndex = 0;

  while ((match = DIRECTIVE_REGEX.exec(llmResponse)) !== null) {
    const agentShortId = match[1].trim();
    const content = match[2].trim();

    directives.push({
      agentShortId,
      content,
    });
  }

  // Fallback: if no structured directives found, try simple format
  // [TO:#agentId] content
  if (directives.length === 0) {
    const SIMPLE_REGEX = /\[TO:#([^\]]+)\]\s*([\s\S]*?)(?=\[TO:#|\[AGENT_DONE:|$)/g;
    SIMPLE_REGEX.lastIndex = 0;

    while ((match = SIMPLE_REGEX.exec(llmResponse)) !== null) {
      const agentShortId = match[1].trim();
      const content = match[2].trim();
      if (content) {
        directives.push({ agentShortId, content });
      }
    }
  }

  return directives;
}

// ---------------------------------------------------------------------------
// Parse [AGENT_DONE:#agentId] markers
// ---------------------------------------------------------------------------

const AGENT_DONE_REGEX = /\[AGENT_DONE:#([^\]]+)\]/g;

export function parseAgentDoneMarkers(llmResponse: string): string[] {
  const doneAgents: string[] = [];
  let match: RegExpExecArray | null;

  AGENT_DONE_REGEX.lastIndex = 0;

  while ((match = AGENT_DONE_REGEX.exec(llmResponse)) !== null) {
    doneAgents.push(match[1].trim());
  }

  return doneAgents;
}

// ---------------------------------------------------------------------------
// Parse [ORCHESTRATE:#agent1,#agent2] markers (from idle mode)
// ---------------------------------------------------------------------------

const ORCHESTRATE_REGEX = /\[ORCHESTRATE:(#[^\]]+)\]/;

export function parseOrchestrateMarker(llmResponse: string): string[] | null {
  const match = ORCHESTRATE_REGEX.exec(llmResponse);
  if (!match) return null;

  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^#/, ""))
    .filter(Boolean);
}
