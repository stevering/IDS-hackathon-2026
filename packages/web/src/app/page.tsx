"use client";

// `UIMessage` is the structural type from the AI SDK that the rest of
// page.tsx was originally written against (from the `useChat` era).
// Imported from the `ai` core package — NOT `@ai-sdk/react`, which
// was decommissioned in April 2026 and only re-exported this type.
import type { UIMessage } from "ai";
import { useChatWorkflow } from "./hooks/useChatWorkflow";
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import type { GatewayModel } from "./api/gateway-models/route";
import { useFigmaPlugin, pushPluginEvent, type PluginEvent, type FigmaPluginContext, type ExecuteCodeResult } from "./hooks/useFigmaPlugin";
import { useFigmaExecuteChannel } from "./hooks/useFigmaExecuteChannel";
import { useClientRegistry } from "./hooks/useClientRegistry";
import { TargetSelector, type TargetItem } from "@/components/TargetSelector";
import { useUserMCPInstances } from "./hooks/useUserMCPInstances";
import { UserMenu } from "@/components/UserMenu";
import { EditableClientId } from "@/components/EditableClientId";
import { GlassDropdown } from "@/components/GlassDropdown";
import { PeekBanner } from "@/components/PeekBanner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useConversations } from "./hooks/useConversations";
import { matchesShortId, type CollaboratorInfo } from "./hooks/useOrchestration";
import { useTemporalOrchestration } from "./hooks/useTemporalOrchestration";
import type { AgentRole, Orchestration } from "@/types/orchestration";
import { ConversationSwitcher } from "@/components/ConversationSwitcher";
import { ConversationSidebar } from "@/components/ConversationSidebar";
import { OrchestrationStatusBar } from "@/components/OrchestrationStatusBar";
import { OrchestrationEventLog } from "@/components/OrchestrationEventLog";
import { OrchestrationChatView } from "@/components/OrchestrationChatView";
import { OrchestrationBanner } from "@/components/OrchestrationBanner";
import { ApprovalOverlay } from "@/components/ApprovalOverlay";
import { useOrchestrationConversation } from "./hooks/useOrchestrationConversation";
import { useDebugTrace, type UnifiedDebugReport } from "./hooks/useDebugTrace";
import { detectCriticalOperations, isCriticalOperation } from "@/lib/guard";
import { MCPStatusBar } from "@/components/MCPStatusBar";

import { AgentMessageBubble } from "@/components/AgentMessageBubble";
import { MentionAutocomplete, type MentionSuggestion, parseMentions } from "@/components/MentionAutocomplete";
import { AutoAcceptToggle } from "@/components/AutoAcceptToggle";
import { GuardianSendButton } from "@/components/guardian/GuardianSendButton";
import { ComposerAurora } from "@/components/guardian/ComposerAurora";
import { PhaseBubble } from "@/components/guardian/PhaseBubble";
import { useGuardianPhase } from "@/components/guardian/useGuardianPhase";
import { useOrchestrationPhase } from "@/components/guardian/useOrchestrationPhase";
import { StreamingMarkdown } from "@/components/chat/StreamingMarkdown";
import { ThinkingBlock } from "@/components/chat/ThinkingBlock";
import { DetailsBlock } from "@/components/chat/DetailsBlock";
import { QCMBlock } from "@/components/chat/QCMBlock";
import { ToolCallBlock } from "@/components/chat/ToolCallBlock";
import { ToolCallProgress } from "@/components/chat/ToolCallProgress";
import { MCPErrorBlock } from "@/components/chat/MCPErrorBlock";
import { markdownComponents } from "@/components/chat/markdown-components";
import { fixUnpairedMarkdown } from "@/lib/markdown-utils";
import { parseStructuredContent, parseTextWithImages, type StructuredSegment, type Segment } from "@/lib/content-parsing";


function MCPStatusBlock({ status }: { status: "connecting" | "connected" | "error" }) {
  const [phase, setPhase] = useState<'mounting' | 'entering' | 'entered' | 'exiting' | 'unmounted'>('mounting');
  const [localStatus, setLocalStatus] = useState<"connecting" | "error">(status as any);
  const mountTimeRef = useRef(Date.now());

  useEffect(() => {
    if (status === "connected") {
      const totalDisplayMin = 1500; // Min 1.5s visible
      const elapsed = Date.now() - mountTimeRef.current;
      const delayHide = Math.max(0, totalDisplayMin - elapsed);
      const timer = setTimeout(() => {
        setPhase('exiting');
        const fadeTimer = setTimeout(() => setPhase('unmounted'), 400);
        return () => clearTimeout(fadeTimer);
      }, delayHide);
      return () => clearTimeout(timer);
    } else {
      // Fade in sequence
      setPhase('entering');
      setTimeout(() => setPhase('entered'), 150); // Fade in 150ms
      setLocalStatus(status);
      mountTimeRef.current = Date.now();
    }
  }, [status]);

  if (phase === 'unmounted' || phase === 'mounting') return null;

  const isError = localStatus === "error";
  const isEntering = phase === 'entering';
  const isExiting = phase === 'exiting';

  const transformClass = isEntering ? 'opacity-0 scale-95 translate-y-4' : 
                          isExiting ? 'opacity-0 scale-95 translate-y-2' : 
                          'opacity-100 scale-100 translate-y-0';

  return (
    <div className={`my-3 p-3 rounded-lg border transition-all duration-400 ease-out ${transformClass} ${isError ? "bg-red-500/5 border-red-500/20" : "bg-blue-500/5 border-blue-500/20"}`}>
      <div className="flex items-center gap-3">
        {isError ? (
          <svg className={`h-5 w-5 ${isEntering || isExiting ? 'opacity-70' : ''} text-red-400/70 shrink-0 transition-opacity`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ) : (
          <svg className={`animate-spin h-5 w-5 text-blue-400/70 shrink-0 transition-opacity ${isExiting ? "opacity-50" : ""}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        <div className="flex-1">
          <h4 className={`text-sm font-medium transition-all duration-300 ${isError ? "text-red-300/90" : "text-blue-300/90"} ${isEntering || isExiting ? "opacity-80" : "opacity-100"}`}>
            {isError ? "MCP Connection Failed" : "Connecting to MCP servers..."}
          </h4>
          <p className={`text-xs text-white/60 transition-all duration-300 ${isEntering || isExiting ? "opacity-70" : "opacity-100"}`}>
            {isError
              ? "Unable to connect to MCP servers. Some features may be unavailable."
              : "Please wait while we establish connection to Figma and Code MCP servers..."}
          </p>
        </div>
      </div>
    </div>
  );
}


/** Clipboard helper — falls back to execCommand for iframes without clipboard API */
function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
  }
  return execCommandCopy(text);
}

function execCommandCopy(text: string): Promise<void> {
  return new Promise((resolve) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    resolve();
  });
}

// ---------------------------------------------------------------------------
// CopyDebugButton — pushes trace to Supabase, fetches unified report, copies
// ---------------------------------------------------------------------------

/** Build a local timeline from events (used for both local-only and per-client traces) */
function buildTimeline(
  eventLog: PluginEvent[],
  clients: { clientId: string; shortId: string; label: string; type: string; fileKey?: string; agentRole?: AgentRole; figmaContext?: { fileName?: string } }[],
  myShortId: string,
  myClientId: string,
  model: string,
  isFigmaPlugin: boolean,
  figmaContext: FigmaPluginContext | null,
) {
  const resolveId = (id: string | undefined) => {
    if (!id) return undefined;
    const c = clients.find(cl => cl.clientId === id);
    return c?.shortId ?? id;
  };
  const pluginParentLabel = isFigmaPlugin
    ? (clients.find(c => c.type === "figma-plugin" && c.fileKey === figmaContext?.fileKey)?.shortId ?? "figma-plugin")
    : "self (no plugin)";

  return eventLog
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map(e => {
      let from: string | undefined = e.from ? resolveId(e.from) : undefined;
      let to: string | undefined = e.to ? resolveId(e.to) : undefined;
      let fromId: string | undefined = e.from ?? undefined;
      let toId: string | undefined = e.to ?? undefined;

      if (!from && !to) {
        const aiLabel = model;
        if (e.channel === "chat") {
          switch (e.type) {
            case "chat:user":
              from = myShortId; fromId = myClientId; to = aiLabel; break;
            case "chat:mcp-status":
              from = "server"; to = myShortId; toId = myClientId; break;
            case "chat:reasoning":
              from = aiLabel; to = myShortId; toId = myClientId; break;
            case "chat:tool:call":
              from = aiLabel; to = e.summary; break;
            case "chat:tool:result":
            case "chat:tool:error":
              from = e.summary; to = aiLabel; break;
            case "chat:assistant:text":
              from = aiLabel; to = myShortId; toId = myClientId; break;
            default:
              if (e.type.includes("user")) { from = myShortId; fromId = myClientId; to = aiLabel; }
              else { from = aiLabel; to = myShortId; toId = myClientId; }
          }
        } else if (e.channel === "postMessage") {
          if (e.dir === "out") { from = myShortId; fromId = myClientId; to = pluginParentLabel; }
          else { from = pluginParentLabel; to = myShortId; toId = myClientId; }
        } else if (e.channel === "supabase") {
          if (e.dir === "out") { from = myShortId; fromId = myClientId; to = "broadcast"; }
          else { from = "broadcast"; to = myShortId; toId = myClientId; }
        }
      }

      const showFromId = fromId && fromId !== from && fromId !== "mcp-server" && fromId !== "server";
      const showToId = toId && toId !== to && toId !== "mcp-server" && toId !== "server";

      const resolvedParts = e.parts?.map((part: unknown) => {
        if (!part || typeof part !== "object") return part;
        const p = part as Record<string, unknown>;
        if (p.output && typeof p.output === "object") {
          const out = p.output as Record<string, unknown>;
          if (Array.isArray(out.result)) {
            return {
              ...p,
              output: {
                ...out,
                result: (out.result as Record<string, unknown>[]).map(r => ({
                  ...r,
                  ...(typeof r.clientId === "string" ? { client: resolveId(r.clientId as string) } : {}),
                })),
              },
            };
          }
        }
        return part;
      });

      const resolvedMeta = e.meta
        ? {
            ...e.meta,
            ...(typeof e.meta.respondedBy === "string"
              ? { respondedById: e.meta.respondedBy, respondedBy: resolveId(e.meta.respondedBy as string) }
              : {}),
          }
        : undefined;

      return {
        ts: new Date(e.ts).toISOString(),
        dir: e.dir,
        from,
        ...(showFromId ? { fromId } : {}),
        to,
        ...(showToId ? { toId } : {}),
        channel: e.channel,
        type: e.type,
        ...(e.summary ? { summary: e.summary } : {}),
        ...(resolvedParts ? { parts: resolvedParts } : {}),
        ...(resolvedMeta ? { meta: resolvedMeta } : {}),
      };
    });
}

function CopyDebugButton({
  messages,
  clients,
  myClientId,
  myShortId,
  agentRole,
  orchestration,
  collaborators,
  activeConversationId,
  conversations,
  model,
  chatStatus,
  chatError,
  enabledMcps,
  mcpReachable,
  isFigmaPlugin,
  figmaContext,
  selectedNodeCount,
  eventLog,
  temporalOrchestration,
  pushTrace,
  fetchUnifiedDebug,
}: {
  messages: { id: string; role: string; parts: { type: string; text?: string }[] }[];
  clients: { clientId: string; shortId: string; label: string; type: string; fileKey?: string; agentRole?: AgentRole; figmaContext?: { fileName?: string } }[];
  myClientId: string;
  myShortId: string;
  agentRole: AgentRole;
  orchestration: Orchestration | null;
  collaborators: CollaboratorInfo[];
  activeConversationId: string | null;
  conversations: { id: string; title: string; orchestration_id: string | null }[];
  model: string;
  chatStatus: string;
  chatError: Error | null | undefined;
  enabledMcps: Record<string, boolean>;
  mcpReachable: Record<string, boolean>;
  isFigmaPlugin: boolean;
  figmaContext: FigmaPluginContext | null;
  selectedNodeCount: number;
  eventLog: PluginEvent[];
  temporalOrchestration?: {
    workflowId: string | null;
    isActive: boolean;
    completedStatus: string | null;
    agents: { shortId: string; status: string; label?: string; fileName?: string }[];
    events: { type: string; [key: string]: unknown }[];
    connected: boolean;
    streamError: string | null;
    timerRemainingMs: number | null;
  };
  pushTrace: (
    events: PluginEvent[],
    clientState: Record<string, unknown>,
    meta: { sourceClientId: string; sourceShortId?: string; clientType?: string }
  ) => Promise<boolean>;
  fetchUnifiedDebug: () => Promise<UnifiedDebugReport | null>;
}) {
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleCopy = async () => {
    setLoading(true);
    try {
      // Build client state snapshot
      // Include orchestration SSE events in the webapp's trace so they're available from Supabase
      const orchEvents = temporalOrchestration?.events ?? [];
      const orchAgents = temporalOrchestration?.agents ?? [];
      const clientState: Record<string, unknown> = {
        model,
        agentRole,
        enabledMcps,
        mcpReachable,
        isFigmaPlugin,
        selectedNodeCount,
        ...(figmaContext ? {
          figmaContext: {
            fileKey: figmaContext.fileKey,
            fileName: figmaContext.fileName,
            currentPage: figmaContext.currentPage,
          },
        } : {}),
        ...(orchEvents.length > 0 ? {
          orchestrationEvents: orchEvents,
          orchestrationAgents: orchAgents,
          orchestrationWorkflowId: temporalOrchestration?.workflowId,
          orchestrationCompletedStatus: temporalOrchestration?.completedStatus,
        } : {}),
      };

      // Step 1: push this client's trace (upserts — updates if already pushed)
      await pushTrace(eventLog, clientState, {
        sourceClientId: myClientId,
        sourceShortId: myShortId,
        clientType: isFigmaPlugin ? "figma-plugin" : "webapp",
      });

      // Step 2: fetch unified traces from all clients
      const unified = await fetchUnifiedDebug();

      // Step 3: build debug JSON
      const hasMultipleClients = unified && unified.traces.length > 1;
      const isOrchestration = !!(unified?.orchestrationId || unified?.workflowId || temporalOrchestration?.workflowId);
      const conversationType = isOrchestration ? "orchestration" : "classic";

      // Unified timeline: merge all client traces sorted by ts
      const unifiedTimeline = unified
        ? unified.traces.flatMap(t =>
            (t.events as PluginEvent[]).map(e => ({
              ts: new Date(e.ts).toISOString(),
              sourceShortId: t.sourceShortId,
              sourceClientId: t.sourceClientId,
              dir: e.dir,
              channel: e.channel,
              type: e.type,
              ...(e.summary ? { summary: e.summary } : {}),
              ...(e.parts ? { parts: e.parts } : {}),
              ...(e.from ? { from: e.from } : {}),
              ...(e.to ? { to: e.to } : {}),
              ...(e.meta ? { meta: e.meta } : {}),
            }))
          ).sort((a, b) => {
            const dt = new Date(a.ts).getTime() - new Date(b.ts).getTime();
            // Stable sort: tiebreak by sourceClientId so order is deterministic across clients
            return dt !== 0 ? dt : a.sourceClientId.localeCompare(b.sourceClientId);
          })
        : [];

      // Per-client breakdown — use each trace's own clientState for resolution
      const perClient: Record<string, unknown> = {};
      if (unified) {
        for (const t of unified.traces) {
          const cs = (t.clientState ?? {}) as Record<string, unknown>;
          const traceFigmaCtx = cs.figmaContext as FigmaPluginContext | null ?? null;
          perClient[t.sourceClientId] = {
            shortId: t.sourceShortId,
            clientType: t.clientType,
            clientState: t.clientState,
            eventCount: (t.events as unknown[]).length,
            timeline: buildTimeline(
              t.events as PluginEvent[],
              clients,
              t.sourceShortId ?? t.sourceClientId,
              t.sourceClientId,
              cs.model as string ?? model,
              cs.isFigmaPlugin as boolean ?? false,
              traceFigmaCtx,
            ),
          };
        }
      }

      const debugData = {
        timestamp: new Date().toISOString(),
        conversationId: activeConversationId,
        conversationType,

        thisClient: { clientId: myClientId, shortId: myShortId, clientType: isFigmaPlugin ? "figma-plugin" : "webapp", agentRole },
        connectedClients: clients.map(c => ({ clientId: c.clientId, shortId: c.shortId, label: c.label, type: c.type, agentRole: c.agentRole, fileName: c.figmaContext?.fileName })),
        model,
        chatStatus,
        ...(chatError ? { chatError: chatError.message } : {}),
        isFigmaPlugin,
        ...(figmaContext ? {
          figmaContext: {
            fileKey: figmaContext.fileKey,
            fileName: figmaContext.fileName,
            currentPage: figmaContext.currentPage,
            currentUser: figmaContext.currentUser,
          },
        } : {}),
        selectedNodeCount,
        enabledMcps,
        mcpReachable,
        ...(temporalOrchestration?.workflowId ? {
          temporalOrchestration: {
            workflowId: temporalOrchestration.workflowId,
            isActive: temporalOrchestration.isActive,
            completedStatus: temporalOrchestration.completedStatus,
            connected: temporalOrchestration.connected,
            streamError: temporalOrchestration.streamError,
            timerRemainingMs: temporalOrchestration.timerRemainingMs,
            agents: temporalOrchestration.agents,
            eventCount: temporalOrchestration.events.length,
            events: temporalOrchestration.events,
          },
        } : {}),

        orchestration: orchestration
          ? { id: orchestration.id, status: orchestration.status, orchestratorClientId: orchestration.orchestratorClientId, conversationId: orchestration.conversationId }
          : null,
        collaborators: collaborators.map(c => ({ clientId: c.clientId, shortId: c.shortId, label: c.label, status: c.status, task: c.task, conversationId: c.conversationId })),
        conversations: conversations.map(c => ({ id: c.id, title: c.title, orchestrationId: c.orchestration_id })),

        // Local timeline (always included — same format as before for backward compat)
        timeline: buildTimeline(eventLog, clients, myShortId, myClientId, model, isFigmaPlugin, figmaContext),

        // Unified data (from all clients persisted in Supabase)
        ...(hasMultipleClients ? { unifiedTimeline } : {}),
        perClient,
        ...(unified?.temporalHistory ? { temporalHistory: unified.temporalHistory } : {}),
      };

      const preamble = `<guardian-debug-context>
Below is a unified debug snapshot from the Guardian webapp (a Figma-integrated AI design assistant).
Use it to understand what happened during the session. Traces are persisted in Supabase and merged from all connected clients.

Key concepts:
- conversationType: "classic" (single client) or "orchestration" (multi-client with Temporal).
- timeline: chronological log from THIS client (same as before, always present).
  Each entry has: ts (timestamp), dir, from (sender shortId), to (receiver shortId), channel, type.
  When from/to refer to a connected client, fromId/toId contain the raw clientId for cross-referencing
  with connectedClients. Labels like "server", model name, or tool name have no clientId.
- unifiedTimeline: all events from ALL connected clients, sorted by ts, each tagged with sourceShortId/sourceClientId. Only present when multiple clients contributed traces.
- perClient: per-client breakdown with metadata snapshots (clientState) and individual timelines.
- temporalHistory: Temporal workflow internals (only for orchestrations) — signals, activities, child workflows.
- channel "chat" event types (live events have accurate per-part timestamps):
  - "chat:user" = user message sent to the AI. parts[0] has { type:"text", text }.
  - "chat:mcp-status" = MCP connection status change. summary is "connecting", "connected", or "error".
  - "chat:reasoning" = AI internal reasoning/thinking. parts[0] has { type:"reasoning", text }.
  - "chat:tool:call" = AI invoked a tool (input available). parts[0] has { type:"tool", tool, input }.
  - "chat:tool:result" = tool execution completed. parts[0] has { type:"tool", tool, output }.
  - "chat:tool:error" = tool execution failed. parts[0] has { type:"tool", tool, error }.
  - "chat:assistant:text" = AI text response (after tool calls or standalone). parts[0] has { type:"text", text }.
  - "chat:history:*" = loaded from DB (past session). History entries are grouped per message
    with all parts inline (interleaved text, mcp-status, and tool parts).
  Live chat events are logged individually as they happen, so tool:call events appear BEFORE
  execution infrastructure events (supabase) and tool:result events appear AFTER.
  postMessage events are only included when the webapp runs inside a Figma plugin iframe.
- channel "postMessage": messages between the webapp and the Figma plugin iframe (selection changes, code execution, handshake...). Only present when isFigmaPlugin=true.
- channel "supabase": Supabase Realtime events (MCP code execution requests/results, multi-agent orchestration).
- Non-chat entries have an optional "summary" with the event content.
- Some events include a "meta" object with additional context (e.g. execution stats:
  respondedBy, totalExecutions, expectedClients for figma execute tools).
- enabledMcps: user toggles for MCP integrations. mcpReachable: which ones actually responded to pings.
- model: selected in UI (server may resolve differently via BYOK/free-tier logic).
- thisClient: this browser tab. connectedClients: all tabs/plugins connected via presence.

`;

      const text = preamble + "```json\n" + JSON.stringify(debugData, null, 2) + "\n```\n</guardian-debug-context>";
      await copyToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex mt-1">
      <button
        onClick={handleCopy}
        disabled={loading}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-white/15 hover:text-white/50 hover:bg-white/5 transition-colors cursor-pointer disabled:opacity-30"
        title="Copy debug context to clipboard"
      >
        {copied ? (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Copied
          </>
        ) : loading ? (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round" />
            </svg>
            Syncing...
          </>
        ) : (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            Debug
          </>
        )}
      </button>
    </div>
  );
}

export default function Home() {
  // ── Figma plugin bridge ─────────────────────────────────────────────
  const { isFigmaPlugin, figmaContext, sendToPlugin, executeCode, eventLog } = useFigmaPlugin();
  const clientTypeForChannel: "figma-plugin" | "webapp" = isFigmaPlugin ? "figma-plugin" : "webapp";
  const clientLabel = (() => {
    if (typeof navigator === "undefined") return "Browser";
    const ua = navigator.userAgent;
    if (isFigmaPlugin) {
      // Figma Desktop uses an Electron-like shell (no Chrome/Firefox in UA)
      const isFigmaDesktop = /Figma/i.test(ua) || (!/Chrome|Firefox|Edg/i.test(ua) && /Safari/i.test(ua));
      return isFigmaDesktop ? "Figma-Desktop" : "Figma-Web";
    }
    return ua.split(" ").pop()?.split("/")[0] ?? "Browser";
  })();
  const clientFileKey = figmaContext?.fileKey ?? undefined;

  // When inside an iframe, wait for the Figma handshake before registering.
  // This avoids registering as "webapp/Safari" before isFigmaPlugin turns true.
  const isInIframe = typeof window !== "undefined" && window.parent !== window;
  const [iframeSettled, setIframeSettled] = useState(!isInIframe);
  useEffect(() => {
    if (!isInIframe) return;
    if (isFigmaPlugin) { setIframeSettled(true); return; }
    // Give the plugin handshake 500ms to complete, then settle as webapp
    const timer = setTimeout(() => setIframeSettled(true), 500);
    return () => clearTimeout(timer);
  }, [isInIframe, isFigmaPlugin]);

  // Get clientId from channel hook first, then register with server
  const [registryShortId, setRegistryShortId] = useState<string | null>(null);

  // Stable ref for plugin live workflowId detection — set later to feed
  // setLiveDetectedWorkflowId once the parent state hook is declared.
  const orchDetectedRef = useRef<((wfId: string) => void) | null>(null);
  const orchDetectedCallback = useCallback((wfId: string) => {
    orchDetectedRef.current?.(wfId);
  }, []);

  // ── Approval-gated executeCode wrapper ────────────────────────────
  // Refs for approval state (declared later, wired via refs to avoid hook order issues)
  const approvalModeRef = useRef<"trust" | "brave">("trust");
  const guardEnabledRef = useRef(true);
  const allowAllSessionRef = useRef(false);
  const setPendingApprovalRef = useRef<(val: {
    code: string;
    agentLabel?: string;
    resolve: (approved: boolean) => void;
  } | null) => void>(() => {});

  const gatedExecuteCode = useCallback(
    async (code: string, timeout?: number): Promise<ExecuteCodeResult> => {
      const mode = approvalModeRef.current;
      const guard = guardEnabledRef.current;
      const sessionAllowed = allowAllSessionRef.current;
      const critical = isCriticalOperation(code);

      // Brave mode: always auto-execute, no exceptions
      if (mode === "brave") {
        return executeCode(code, timeout);
      }

      // Trust mode with "Allow all session" — skip approval for non-critical ops
      // Guard forces approval on critical ops even with "Allow all session"
      if (sessionAllowed && !(guard && critical)) {
        return executeCode(code, timeout);
      }

      // Show approval overlay and wait for user decision
      return new Promise<ExecuteCodeResult>((resolve) => {
        setPendingApprovalRef.current({
          code,
          resolve: (approved: boolean) => {
            if (approved) {
              executeCode(code, timeout).then(resolve);
            } else {
              resolve({ success: false, error: "User rejected execution" });
            }
          },
        });
      });
    },
    [executeCode],
  );

  // All clients go through the approval gate.
  // In brave mode: auto-execute (unless guard flags critical ops).
  // In trust mode: show ApprovalOverlay before each execution.
  const channelExecuteCode = gatedExecuteCode;

  const { clients, clientId: myClientId, connectionStatus, channelRef } = useFigmaExecuteChannel(channelExecuteCode, true, {
    type: clientTypeForChannel,
    label: clientLabel,
    fileKey: clientFileKey,
    figmaContext: isFigmaPlugin && figmaContext ? {
      fileName: figmaContext.fileName,
      fileUrl: figmaContext.fileUrl,
      pages: figmaContext.pages,
      currentPage: figmaContext.currentPage,
      currentUser: figmaContext.currentUser,
    } : undefined,
    serverShortId: registryShortId,
  }, eventLog, isFigmaPlugin ? orchDetectedCallback : undefined);

  // Register client with the server-side registry (needs clientId from channel hook)
  // Wait for iframe detection to settle so we send the correct type/label
  const { shortId: serverShortId, rename: renameClient } = useClientRegistry(
    myClientId,
    clientTypeForChannel,
    clientLabel,
    clientFileKey,
    !!myClientId && iframeSettled,
  );

  // Sync server shortId to presence via state (avoids circular hook deps)
  useEffect(() => {
    if (serverShortId && serverShortId !== registryShortId) {
      setRegistryShortId(serverShortId);
    }
  }, [serverShortId, registryShortId]);

  // Use server-assigned shortId, falling back to presence-derived one
  const myDisplayShortId = registryShortId ?? clients.find(c => c.clientId === myClientId)?.shortId ?? myClientId;

  // ── Conversation persistence ────────────────────────────────────────
  const {
    conversations,
    allConversations,
    childrenMap,
    activeConversation,
    activeConversationId,
    parallelConversations,
    createConversation,
    switchConversation,
    deleteConversation,
    updateTitle,
    renameConversation,
    loadConversations,
    ensureConversation,
  } = useConversations(myClientId, !!myClientId);

  // ── Derive workflowId from active conversation metadata ──
  // When navigating to an orchestration conversation (sidebar click, F5 restore),
  // extract the workflowId so the SSE stream can connect without needing
  // startOrchestration() to have been called in this session.
  const activeConvMeta = allConversations.find((c) => c.id === activeConversationId)?.metadata as Record<string, unknown> | undefined;
  const activeConvWorkflowId = (activeConvMeta?.workflowId as string) ?? null;

  // ── Live workflowId detection (plugin-only) ───────────────────────
  // When the plugin receives an execute_request via postMessage, the workflowId
  // arrives before any conversation metadata exists. Hold it in state so the
  // SSE stream attaches immediately, and so useOrchestrationConversation can
  // create the silent sub-conv (no auto-switch in plugin).
  const [liveDetectedWorkflowId, setLiveDetectedWorkflowId] = useState<string | null>(null);
  orchDetectedRef.current = (wfId: string) => {
    setLiveDetectedWorkflowId(wfId);
  };

  // Effective external workflowId: prefer the active conv's metadata,
  // fall back to the live-detected workflowId on the parent chat (plugin).
  const externalWorkflowId = activeConvWorkflowId ?? (isFigmaPlugin ? liveDetectedWorkflowId : null);

  // ── Collaborative Agents orchestration ──────────────────────────────
  // Orchestration runs on Temporal (backend workflows + SSE).
  // Pass externalWorkflowId so the stream connects on page reload AND on live
  // execute_request arrivals in the plugin.
  const temporal = useTemporalOrchestration(externalWorkflowId);

  // ── Orchestration conversation (shared between webapp and plugin) ──
  // Viewer-only: the sub-conv is created by the server in /api/orchestration/start.
  // Plugin: isFigmaPlugin=true suppresses auto-switch to the sub-conv,
  //         so the user keeps typing in their parent chat.
  // Webapp: auto-switch only fires for user-initiated runs (the chat button),
  //         not for MCP-triggered or externally-discovered workflows.
  const orchConv = useOrchestrationConversation({
    workflowId: temporal.workflowId,
    activeConversationId,
    conversations: allConversations,
    switchConversation,
    isFigmaPlugin,
    autoSwitchOnWorkflowId: temporal.userInitiatedWorkflowId,
  });

  // ── Debug traces (persistent, unified across clients) ─────────────
  const activeWorkflowId = temporal.workflowId;
  const { pushTrace, fetchUnifiedDebug } = useDebugTrace(activeConversationId, activeWorkflowId);

  // ── Trust/Brave approval state ────────────────────────────────────
  const [approvalMode, setApprovalMode] = useState<"trust" | "brave">("trust");
  const [guardEnabled, setGuardEnabled] = useState(true);
  const [developerMode, setDeveloperMode] = useState(false);
  const [devShowAllEvents, setDevShowAllEvents] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{
    code: string;
    agentLabel?: string;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [allowAllSession, setAllowAllSession] = useState(false);

  // Sync approval refs so the gated wrapper (declared earlier) sees latest state
  approvalModeRef.current = approvalMode;
  guardEnabledRef.current = guardEnabled;
  allowAllSessionRef.current = allowAllSession;
  setPendingApprovalRef.current = setPendingApproval;

  // Fetch user settings on mount (approval mode + guard)
  useEffect(() => {
    fetch("/api/user/settings")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.approvalMode) setApprovalMode(data.approvalMode);
        if (typeof data?.guardEnabled === "boolean") setGuardEnabled(data.guardEnabled);
        if (typeof data?.developerMode === "boolean") setDeveloperMode(data.developerMode);
        if (typeof data?.devShowAllEvents === "boolean") setDevShowAllEvents(data.devShowAllEvents);
      })
      .catch(() => {});
  }, []);

  // Legacy orchestration values — kept as static defaults for any remaining
  // UI references during the transition. Will be removed in a future cleanup.
  const agentRole: AgentRole = "idle";
  const orchestration: Orchestration | null = null;
  const collaborators: CollaboratorInfo[] = [];
  const timerRemainingMs: number | null = null;

  const [selectedDesignTarget, setSelectedDesignTarget] = useState<string | null>(null);
  const [selectedCodeTarget, setSelectedCodeTarget] = useState<string | null>(null);

  // New MCP instances hook (Phase 4) — sources TargetSelector items
  const mcpInstances = useUserMCPInstances();

  // Seed the TargetSelector selection from user_category_defaults (DB) once
  // instances are loaded, so the chat starts with the user's preferred focus
  // instead of null. Without this, the first Send fires with
  // designInstanceId=undefined and the chatWorkflow falls back to V1 legacy
  // → the LLM never sees local instances like figmadesktop as focus tools.
  // Only seeds if the user hasn't made an explicit choice this session.
  const defaultsApplied = useRef(false);
  useEffect(() => {
    if (defaultsApplied.current) return;
    if (mcpInstances.loading) return;
    if (mcpInstances.instances.length === 0) return;
    defaultsApplied.current = true;

    if (selectedDesignTarget === null && mcpInstances.defaults.design) {
      setSelectedDesignTarget(`instance:${mcpInstances.defaults.design}`);
    }
    if (selectedCodeTarget === null && mcpInstances.defaults.code) {
      setSelectedCodeTarget(`instance:${mcpInstances.defaults.code}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpInstances.loading, mcpInstances.instances.length, mcpInstances.defaults.design, mcpInstances.defaults.code]);



  const isDev = process.env.NODE_ENV === 'development';
  const [figmaMcpUrl, setFigmaMcpUrl] = useState(
      isDev ? process.env.NEXT_PUBLIC_PROXY_LOCAL_FIGMA_MCP : process.env.NEXT_PUBLIC_LOCAL_MCP_FIGMA_URL
  );
  const [codeProjectPath, setCodeProjectPath] = useState(
      isDev ? process.env.NEXT_PUBLIC_PROXY_LOCAL_CODE_MCP : process.env.NEXT_PUBLIC_LOCAL_MCP_CODE_URL
  );//"http://[::1]:3846/sse");
  const [figmaAccessToken, setFigmaAccessToken] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Sync collapsed state from localStorage after hydration
  useEffect(() => {
    const stored = localStorage.getItem("guardian-sidebar-collapsed");
    if (stored === "true") setSidebarCollapsed(true);
  }, []);
  const toggleSidebar = useCallback(() => {
    // On mobile: toggle open/close. On desktop: toggle collapsed/expanded.
    if (window.innerWidth < 768) {
      setSidebarOpen((prev) => !prev);
    } else {
      setSidebarCollapsed((prev) => {
        const next = !prev;
        localStorage.setItem("guardian-sidebar-collapsed", String(next));
        return next;
      });
    }
  }, []);
  const [figmaOAuth, setFigmaOAuth] = useState(false);
  const [southleftOAuth, setSouthleftOAuth] = useState(false);
  const [githubOAuth, setGithubOAuth] = useState(false);
  const [pendingAgentMessage, setPendingAgentMessage] = useState<string | null>(null);
  const [mcpConnectionStatus, setMcpConnectionStatusRaw] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const mcpConnectionStatusRef = useRef(mcpConnectionStatus);
  const setMcpConnectionStatus = useCallback((s: "idle" | "connecting" | "connected" | "error") => {
    if (mcpConnectionStatusRef.current === s) return;
    mcpConnectionStatusRef.current = s;
    setMcpConnectionStatusRaw(s);
  }, []);
  // Stable ref to sendMessage — declared early to be accessible in handleMessage
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendMessageEarlyRef = useRef<((msg: { text: string }) => void) | null>(null);
  const [input, setInput] = useState("");
  // selectedModel: "provider/model-id" (e.g. "openai/gpt-4o" or "google/gemini-2.5-flash")
  const [selectedModel, setSelectedModel] = useState<string>("");
  // selectedSource: "included" (platform quota) or "byok" (user's own key)
  const [selectedSource, setSelectedSource] = useState<"included" | "byok" | null>(null);
  // Which BYOK key is selected (by ID) — set when user picks a model from a specific key
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const modelReady = selectedSource !== null;
  const [byokKeys, setByokKeys] = useState<{ id: string; provider: string; label: string | null; key_hint: string | null; is_default: boolean; default_model: string | null }[]>([]);
  const [gatewayModels, setGatewayModels] = useState<GatewayModel[]>([]);
  // Native model catalogs per direct-provider key (enriched with gateway metadata server-side)
  const [nativeModels, setNativeModels] = useState<Record<string, { id: string; name: string; owned_by: string; tags?: string[]; context_window?: number; max_tokens?: number; gatewayId?: string }[]>>({});
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const [selectedNode, setSelectedNode] = useState<{ nodes: unknown[]; image: string | null; nodeUrl: string | null } | null>(null);
  const [figmaPluginContext, setFigmaPluginContext] = useState<{ fileKey: string; fileName: string; fileUrl: string; currentPage?: { id: string; name: string } | null; pages?: { id: string; name: string }[]; currentUser?: { id: string; name: string } | null } | null>(null);
  const [selectionGlow, setSelectionGlow] = useState(false);
  const [proxyModalOpen, setProxyModalOpen] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelSecret, setTunnelSecret] = useState(process.env.NEXT_PUBLIC_MCP_TUNNEL_SECRET);
  const [localFigmaMcpUrl, setLocalFigmaMcpUrl] = useState(process.env.NEXT_PUBLIC_LOCAL_MCP_FIGMA_URL || "");
  const [localCodeMcpUrl, setLocalCodeMcpUrl] = useState(process.env.NEXT_PUBLIC_LOCAL_MCP_CODE_URL || "");
  const [waitingForOAuth, setWaitingForOAuth] = useState(false);
  const [githubWaitingForOAuth, setGithubWaitingForOAuth] = useState(false);
  const [figmaWaitingForOAuth, setFigmaWaitingForOAuth] = useState(false);
  const githubOAuthSessionRef = useRef<string | null>(null);
  const figmaOAuthSessionRef = useRef<string | null>(null);

  // MCP Toggles - enabled/disabled state (lazy init from localStorage)
  const mcpDefaults = { figma: true, figmaConsole: false, github: false, code: true };
  const [enabledMcps, setEnabledMcps] = useState<Record<string, boolean>>(mcpDefaults);

  // Hydrate from localStorage after mount (avoids SSR/client mismatch)
  useEffect(() => {
    const saved = localStorage.getItem('guardian-enabled-mcps');
    if (saved) {
      try {
        setEnabledMcps(prev => ({ ...prev, ...JSON.parse(saved) }));
      } catch {
        // ignore malformed data
      }
    }
  }, []);

  // Toggle a single MCP and persist immediately (avoids race condition
  // where a save effect on mount would overwrite saved values with defaults)
  const toggleMcp = (key: string) => {
    setEnabledMcps(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('guardian-enabled-mcps', JSON.stringify(next));
      return next;
    });
  };

  // ── Client-side MCP reachability check ──────────────────────────────
  // URL-based MCPs: fetch via proxy (same-origin, no CORS).
  // OAuth MCPs: check localStorage tokens (instant).
  const [mcpReachable, setMcpReachable] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;

    async function pingUrl(url: string): Promise<boolean> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          method: "GET",
          headers: { Accept: "text/event-stream, application/json" },
        });
        clearTimeout(timer);
        controller.abort();
        return res.ok;
      } catch {
        clearTimeout(timer);
        return false;
      }
    }

    async function checkAll() {
      const results: Record<string, boolean> = {};

      // Code MCP — ping the proxy URL (same-origin)
      if (enabledMcps.code !== false && codeProjectPath?.trim()) {
        results.code = await pingUrl(codeProjectPath);
      }

      // Figma MCP — OAuth token check or ping local URL
      if (enabledMcps.figma !== false) {
        if (figmaOAuth) {
          results.figma = typeof window !== "undefined" && !!localStorage.getItem("figma_mcp_tokens");
        } else if (figmaMcpUrl?.trim()) {
          results.figma = await pingUrl(figmaMcpUrl);
        }
      }

      // GitHub MCP — OAuth token check
      if (enabledMcps.github) {
        results.github = typeof window !== "undefined" && !!localStorage.getItem("github_mcp_tokens");
      }

      // Figma Console — OAuth token check
      if (enabledMcps.figmaConsole) {
        results.figmaConsole = typeof window !== "undefined" && !!localStorage.getItem("southleft_access_token");
      }

      if (!cancelled) setMcpReachable(results);
    }

    checkAll();
    const interval = setInterval(checkAll, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [codeProjectPath, figmaMcpUrl, figmaOAuth, enabledMcps]);

  // ── Target items for Design and Code selectors ──────────────────────
  // ── TargetSelector data (Phase 4 — sourced from user_mcp_instances) ──

  const designTargets: TargetItem[] = useMemo(() => {
    const items: TargetItem[] = [];

    // Live Figma plugins from presence (unchanged — not MCP, direct Guardian protocol)
    const plugins = clients.filter(c => c.type === "figma-plugin");
    if (plugins.length > 0) {
      plugins.forEach(c => items.push({
        id: `plugin:${c.clientId}`,
        kind: "plugin",
        label: c.shortId,
        subtitle: c.figmaContext?.currentPage?.name ?? undefined,
        status: "active",
        tooltip: "Active",
        description: "Connected via real-time presence. Commands will be executed in this Figma instance.",
        clientId: c.clientId,
      }));
    } else {
      items.push({
        id: "plugin:none",
        kind: "plugin",
        label: "Plugin",
        status: "not-configured",
        tooltip: "Not configured",
        description: "No Figma plugin detected. Open the Guardian plugin in Figma Desktop or Web to connect.",
      });
    }

    // Design MCP instances from user_mcp_instances (cloud + local)
    for (const inst of mcpInstances.instances.filter(i => i.category === "design" && i.enabled)) {
      const status = inst.ready ? "active" as const
        : inst.connection ? "offline" as const
        : "not-configured" as const;
      items.push({
        id: `instance:${inst.id}`,
        kind: "mcp",
        label: inst.display_name ?? inst.preset?.display_name ?? inst.label,
        subtitle: inst.device ? `${inst.device.name}${inst.device.online ? "" : " (offline)"}` : inst.label,
        status,
        tooltip: status === "active" ? "Active" : status === "offline" ? "Offline" : "Not connected",
        description: inst.preset?.description ?? `${inst.preset_type} MCP`,
      });
    }

    return items;
  }, [clients, mcpInstances.instances]);

  const codeTargets: TargetItem[] = useMemo(() => {
    const items: TargetItem[] = [];

    // Code MCP instances from user_mcp_instances (cloud + local)
    for (const inst of mcpInstances.instances.filter(i => i.category === "code" && i.enabled)) {
      const status = inst.ready ? "active" as const
        : inst.connection ? "offline" as const
        : "not-configured" as const;
      items.push({
        id: `instance:${inst.id}`,
        kind: "mcp",
        label: inst.display_name ?? inst.preset?.display_name ?? inst.label,
        subtitle: inst.device ? `${inst.device.name}${inst.device.online ? "" : " (offline)"}` : inst.label,
        status,
        tooltip: status === "active" ? "Active" : status === "offline" ? "Offline" : "Not connected",
        description: inst.preset?.description ?? `${inst.preset_type} MCP`,
      });
    }

    return items;
  }, [mcpInstances.instances]);

  const handleModelDropdownClose = useCallback(() => {
    setModelDropdownOpen(false);
    setModelSearch("");
  }, []);


  // Load user's BYOK keys + full model catalog + settings on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/user/api-keys").then((r) => r.ok ? r.json() : { keys: [] }),
      fetch("/api/gateway-models").then((r) => r.ok ? r.json() : { models: [] }).catch(() => ({ models: [] })),
      fetch("/api/user/settings").then((r) => r.ok ? r.json() : { defaultModel: null, usageSource: "included" }).catch(() => ({ defaultModel: null, usageSource: "included" })),
    ]).then(async ([keysData, gwData, settingsData]: [Record<string, unknown>, Record<string, unknown>, { defaultModel: string | null; usageSource?: string }]) => {
      const keys = (keysData.keys ?? []) as { id: string; provider: string; label: string | null; key_hint: string | null; is_default: boolean; default_model: string | null }[];
      const models: GatewayModel[] = (gwData.models ?? []) as GatewayModel[];
      const userDefaultModel: string | null = settingsData.defaultModel ?? null;
      const userUsageSource = settingsData.usageSource === "byok" ? "byok" : "included";
      setByokKeys(keys);
      setGatewayModels(models);
      // Don't set selectedSource yet — wait for native catalogs to load first
      // (selectedSource triggers modelReady which shows the selector)

      // Fetch native model catalogs for all direct-provider keys in parallel
      const directKeys = keys.filter((k) => k.provider !== "gateway");
      const nativePromises = directKeys.map((key) =>
        fetch(`/api/user/api-keys/provider-models?keyId=${key.id}`)
          .then((r) => r.ok ? r.json() : null)
          .then((data) => ({ keyId: key.id, models: data?.models ?? [] }))
          .catch(() => ({ keyId: key.id, models: [] as { id: string; name: string; owned_by: string }[] }))
      );

      // Wait for ALL native catalogs before showing the selector
      const nativeResults = await Promise.all(nativePromises);
      const nativeMap: Record<string, { id: string; name: string; owned_by: string }[]> = {};
      for (const { keyId, models: nModels } of nativeResults) {
        if (nModels.length > 0) nativeMap[keyId] = nModels;
      }
      setNativeModels(nativeMap);

      if (userUsageSource === "byok" && keys.length > 0) {
        const defaultKey = keys.find((k) => k.is_default);
        if (defaultKey) {
          setSelectedKeyId(defaultKey.id);
          if (defaultKey.default_model) {
            setSelectedModel(defaultKey.default_model);
            setSelectedSource(userUsageSource);
            return;
          }
          // Fallback: first model from the key's native catalog or gateway
          const keyNative = nativeMap[defaultKey.id];
          if (keyNative?.length) {
            setSelectedModel(`${defaultKey.provider}/${keyNative[0].id}`);
            setSelectedSource(userUsageSource);
            return;
          }
          if (defaultKey.provider === "gateway" && models.length > 0) {
            setSelectedModel(models[0].id);
            setSelectedSource(userUsageSource);
            return;
          }
          // BYOK key exists but no model catalog available (invalid key or provider error)
          // Fall through to included mode — user needs to fix their key
          setSelectedKeyId(null);
        }
      }

      // Included mode (or BYOK with no keys): use user's saved default model
      if (userDefaultModel && userUsageSource === "included") {
        setSelectedModel(userDefaultModel);
      } else {
        setSelectedModel("google/gemini-2.5-flash");
      }
      setSelectedKeyId(null);
      setSelectedSource("included");
    }).catch(() => {});
  }, []);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const orchScrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  const [orchViewMode, setOrchViewMode] = useState<"chat" | "developer">(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("guardian:orchViewMode") as "chat" | "developer") || "chat";
    }
    return "chat";
  });
  const shouldAutoScrollOrch = useRef(true);
  const scrollRafRef = useRef<number | null>(null);

  // Whether we should show the orchestration panel — single source of truth.
  // Plugin uses the same gate; the user navigates via banner click → switchConversation.
  const showOrchPanel = orchConv.isInOrchestrationConversation;

  const figmaMcpUrlRef = useRef(figmaMcpUrl);
  figmaMcpUrlRef.current = figmaMcpUrl;
  const figmaAccessTokenRef = useRef(figmaAccessToken);
  figmaAccessTokenRef.current = figmaAccessToken;
  const codeProjectPathRef = useRef(codeProjectPath);
  codeProjectPathRef.current = codeProjectPath;
  const figmaOAuthRef = useRef(figmaOAuth);
  figmaOAuthRef.current = figmaOAuth;
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;
  const selectedSourceRef = useRef(selectedSource);
  selectedSourceRef.current = selectedSource;
  const selectedKeyIdRef = useRef(selectedKeyId);
  selectedKeyIdRef.current = selectedKeyId;
  const byokKeysRef = useRef(byokKeys);
  byokKeysRef.current = byokKeys;
  const gatewayModelsRef = useRef(gatewayModels);
  gatewayModelsRef.current = gatewayModels;
  const selectedNodeRef = useRef(selectedNode);
  selectedNodeRef.current = selectedNode;
  const figmaPluginContextRef = useRef(figmaPluginContext);
  figmaPluginContextRef.current = figmaPluginContext;
  const clientsRef = useRef(clients);
  clientsRef.current = clients;
  const selectedDesignTargetRef = useRef(selectedDesignTarget);
  selectedDesignTargetRef.current = selectedDesignTarget;
  const designTargetsRef = useRef(designTargets);
  designTargetsRef.current = designTargets;
  const isFigmaPluginRef = useRef(isFigmaPlugin);
  isFigmaPluginRef.current = isFigmaPlugin;
  const myClientIdRef = useRef(myClientId);
  myClientIdRef.current = myClientId;
  const tunnelSecretRef = useRef(tunnelSecret);
  tunnelSecretRef.current = tunnelSecret;
  const oauthSessionRef = useRef<string | null>(null);
  const localFigmaMcpUrlRef = useRef(localFigmaMcpUrl);
  localFigmaMcpUrlRef.current = localFigmaMcpUrl;
  const localCodeMcpUrlRef = useRef(localCodeMcpUrl);
  localCodeMcpUrlRef.current = localCodeMcpUrl;
  const enabledMcpsRef = useRef(enabledMcps);
  enabledMcpsRef.current = enabledMcps;
  const sendToPluginRef = useRef(sendToPlugin);
  sendToPluginRef.current = sendToPlugin;
  const executeCodeRef = useRef(executeCode);
  executeCodeRef.current = executeCode;
  // Notify the Figma plugin that the user is authenticated
  useEffect(() => {
    try {
      window.parent.postMessage({ source: "figpal-webapp", type: "AUTH_STATE", authenticated: true }, "*");
    } catch (_) {}
  }, []);

  // Sync figmaContext from hook → local state used by the rest of the component
  useEffect(() => {
    if (figmaContext) {
      setFigmaPluginContext({
        fileKey: figmaContext.fileKey ?? '',
        fileName: figmaContext.fileName,
        fileUrl: figmaContext.fileUrl ?? '',
        currentPage: figmaContext.currentPage,
        pages: figmaContext.pages,
        currentUser: figmaContext.currentUser,
      });
    }
  }, [figmaContext]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data && typeof event.data === "object" &&
          (event.data.type === "selection-changed" || event.data.type === "response") &&
          "data" in event.data && event.data.data) {
        const d = event.data.data as { nodes?: unknown[]; image?: string | null; nodeUrl?: string | null };
        const d2 = { nodes: d.nodes ?? [], image: d.image ?? null, nodeUrl: d.nodeUrl ?? null };
        console.log(d2);
        setSelectedNode(d2);
      }
      if (event.data && typeof event.data === "object" && event.data.type === "southleft-mcp-auth") {
        console.log('Received southleft-mcp-auth:', event.data.success);
        if (event.data.success) {
          setSouthleftOAuth(true);
        }
      }

      // Reset conversation before a new analysis
      if (event.data && typeof event.data === "object" && event.data.type === "reset-conversation") {
        setMessages([]);
      }

      // Fake agent message injected from the plugin mini-mode tooltip
      if (event.data && typeof event.data === "object" && event.data.type === "inject-agent-message") {
        const text = (event.data as { type: string; text: string }).text;
        setPendingAgentMessage(text);
      }

      // Auto-trigger analysis sent by the plugin 400ms after inject-agent-message
      if (event.data && typeof event.data === "object" && event.data.type === "trigger-user-analysis") {
        sendMessageEarlyRef.current?.({ text: "Yes analyze my new figma selection" });
      }

      // GitHub OAuth popup fast-path
      if (event.data && typeof event.data === "object" && event.data.type === "github-oauth-complete") {
        if (event.data.success) {
          if (event.data.tokensJson && typeof window !== 'undefined') {
            try { localStorage.setItem('github_mcp_tokens', event.data.tokensJson as string); } catch(_) {}
          }
          setGithubOAuth(true);
        }
        setGithubWaitingForOAuth(false);
      }
      if (event.data && typeof event.data === "object" && event.data.type === "github-oauth-error") {
        console.error("[GitHub OAuth] Error from popup:", event.data.error);
        setGithubWaitingForOAuth(false);
      }

      // Figma official OAuth popup fast-path
      if (event.data && typeof event.data === "object" && event.data.type === "figma-oauth-complete") {
        if (event.data.success) {
          if (event.data.tokensJson && typeof window !== 'undefined') {
            try { localStorage.setItem('figma_mcp_tokens', event.data.tokensJson as string); } catch(_) {}
          }
          setFigmaOAuth(true);
        }
        setFigmaWaitingForOAuth(false);
      }
      if (event.data && typeof event.data === "object" && event.data.type === "figma-oauth-error") {
        console.error("[Figma OAuth] Error from popup:", event.data.error);
        setFigmaWaitingForOAuth(false);
      }

      // Token relay from OAuth popup via postMessage
      if (event.data && typeof event.data === "object" && event.data.type === "southleft-oauth-complete") {
        const accessToken = event.data.accessToken as string | undefined;
        if (accessToken) {
          localStorage.setItem('southleft_access_token', accessToken);
          setSouthleftOAuth(true);
          setWaitingForOAuth(false);
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [tunnelSecret]);

  // Check localStorage for southleft access token to determine auth status
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('southleft_access_token');
      setSouthleftOAuth(!!token);
    }
  }, []);

  // If this page is the popup landing after OAuth, relay token to opener then close
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const isAuthSuccess = params.get('auth') === 'success';
    const source = params.get('source');
    const isPopup = params.get('popup') === 'true';

    if (isAuthSuccess && isPopup && source === 'southleft-mcp') {
      const accessToken = localStorage.getItem('southleft_access_token');
      if (accessToken && window.opener) {
        try {
          window.opener.postMessage({ type: 'southleft-oauth-complete', accessToken }, window.location.origin);
        } catch (e) {
          console.warn('[southleft popup] postMessage to opener failed:', e);
        }
      }
      // Give a short delay so the message is dispatched before close
      setTimeout(() => { try { window.close(); } catch (_) {} }, 300);
    }
  }, []);

  // Polling fallback: if postMessage to opener failed, retrieve token from server relay
  useEffect(() => {
    if (!waitingForOAuth) return;
    let interval: NodeJS.Timeout;
    let timeout: NodeJS.Timeout;

    const poll = async () => {
      try {
        const res = await fetch('/api/set-oauth-result', {
          headers: oauthSessionRef.current ? { 'X-Auth-Token': oauthSessionRef.current } : {},
        });
        const data = await res.json();
        if (data?.type === 'southleft-mcp-auth' && data.success && data.access_token) {
          localStorage.setItem('southleft_access_token', data.access_token as string);
          setSouthleftOAuth(true);
          setWaitingForOAuth(false);
        }
      } catch {
        // ignore transient errors
      }
    };

    interval = setInterval(poll, 2000);
    timeout = setTimeout(() => {
      setWaitingForOAuth(false);
      clearInterval(interval);
    }, 60000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [waitingForOAuth]);

  // Polling fallback for GitHub MCP OAuth popup
  useEffect(() => {
    if (!githubWaitingForOAuth) return;
    let interval: NodeJS.Timeout;
    let timeout: NodeJS.Timeout;
    const poll = async () => {
      try {
        const res = await fetch('/api/set-oauth-result', {
          headers: githubOAuthSessionRef.current ? { 'X-Auth-Token': githubOAuthSessionRef.current } : {},
        });
        const data = await res.json();
        if (data?.type === 'github-mcp-auth') {
          if (data.success) {
            const tokensJson = data.tokens?.github_mcp_tokens as string | undefined;
            if (tokensJson) {
              try { localStorage.setItem('github_mcp_tokens', tokensJson); } catch(_) {}
            }
            setGithubOAuth(true);
          }
          setGithubWaitingForOAuth(false);
        }
      } catch { /* ignore */ }
    };
    interval = setInterval(poll, 2000);
    timeout = setTimeout(() => { setGithubWaitingForOAuth(false); clearInterval(interval); }, 60000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [githubWaitingForOAuth]);

  // Polling fallback for Figma official OAuth popup
  useEffect(() => {
    if (!figmaWaitingForOAuth) return;
    let interval: NodeJS.Timeout;
    let timeout: NodeJS.Timeout;
    const poll = async () => {
      try {
        const res = await fetch('/api/set-oauth-result', {
          headers: figmaOAuthSessionRef.current ? { 'X-Auth-Token': figmaOAuthSessionRef.current } : {},
        });
        const data = await res.json();
        if (data?.type === 'figma-mcp-auth') {
          if (data.success) {
            const tokensJson = data.tokens?.figma_mcp_tokens as string | undefined;
            if (tokensJson) {
              try { localStorage.setItem('figma_mcp_tokens', tokensJson); } catch(_) {}
            }
            setFigmaOAuth(true);
          }
          setFigmaWaitingForOAuth(false);
        }
      } catch { /* ignore */ }
    };
    interval = setInterval(poll, 2000);
    timeout = setTimeout(() => { setFigmaWaitingForOAuth(false); clearInterval(interval); }, 60000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [figmaWaitingForOAuth]);

  // Restore GitHub and Figma MCP auth status on mount
  // localStorage takes priority (works in Figma plugin iframe where cookies from OAuth popup are not sent),
  // then fall back to server cookie check.
  useEffect(() => {
    // Figma: localStorage takes priority (works in Figma plugin iframe)
    if (typeof window !== 'undefined' && localStorage.getItem('figma_mcp_tokens')) {
      setFigmaOAuth(true);
    } else {
      fetch("/api/auth/figma-mcp/status", {
        headers: { "X-Auth-Token": tunnelSecret || "" },
      })
        .then((r) => r.json())
        .then((d) => setFigmaOAuth(d.connected))
        .catch(() => {});
    }

    // GitHub: localStorage takes priority (works in Figma plugin iframe)
    if (typeof window !== 'undefined' && localStorage.getItem('github_mcp_tokens')) {
      setGithubOAuth(true);
    } else {
      fetch("/api/auth/github-mcp/status", {
        headers: { "X-Auth-Token": tunnelSecret || "" },
      })
        .then((r) => r.json())
        .then((d) => setGithubOAuth(d.connected))
        .catch(() => {});
    }
  }, [tunnelSecret]);

  useEffect(() => {
    if (selectedNode) {
      setSelectionGlow(true);
      const timer = setTimeout(() => setSelectionGlow(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [selectedNode]);

  // Error banner state — fed by the Temporal chat workflow error sync below.
  // Preserved through the legacy chat cleanup because the PeekBanner UI still
  // renders from these and the Temporal hook forwards its `error` into them.
  const [chatErrorMsg, setChatErrorMsg] = useState<string | null>(null);
  const [errorCount, setErrorCount] = useState(0);

  // (temporal error sync is below, after chatWorkflow declaration)

  const orchCompletedStatus = temporal.completedStatus;

  // ── Dismiss pending approval when orchestration ends ─────────────
  useEffect(() => {
    if (orchCompletedStatus && pendingApproval) {
      pendingApproval.resolve(false);
      setPendingApproval(null);
    }
  }, [orchCompletedStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-push debug trace on orchestration completion ─────────────
  const autoPushFired = useRef(false);
  useEffect(() => {
    if (!orchCompletedStatus) {
      autoPushFired.current = false;
      return;
    }
    if (autoPushFired.current) return;
    const timer = setTimeout(() => {
      autoPushFired.current = true;
      // Include orchestration SSE events in the webapp's trace so they're available from Supabase
      const orchEvents = temporal.events;
      const orchAgents = temporal.agents;
      pushTrace(eventLog.current, {
        model: selectedModel,
        agentRole,
        enabledMcps,
        mcpReachable,
        isFigmaPlugin,
        selectedNodeCount: selectedNode?.nodes?.length ?? 0,
        ...(figmaContext ? { figmaContext: { fileKey: figmaContext.fileKey, fileName: figmaContext.fileName } } : {}),
        ...(orchEvents.length > 0 ? { orchestrationEvents: orchEvents, orchestrationAgents: orchAgents } : {}),
      }, {
        sourceClientId: myClientId,
        sourceShortId: myDisplayShortId,
        clientType: isFigmaPlugin ? "figma-plugin" : "webapp",
      });
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchCompletedStatus]);

  // ── Temporal chat workflow ──────────────────────────────────────────────
  // The legacy `@ai-sdk/react` `useChat` path was removed in April 2026 — the
  // Temporal-backed `useChatWorkflow` hook below is now the only chat runtime.
  // See `docs/architecture/chat-temporal.md` for the full protocol.

  // Map enabledMcps UI keys to Temporal MCP server IDs
  const temporalMcpServerIds = useMemo(() => {
    const ids: string[] = [];
    if (enabledMcps.figma) ids.push("figma_mcp");
    if (enabledMcps.figmaConsole) ids.push("figma_console");
    if (enabledMcps.github) ids.push("github");
    return ids;
  }, [enabledMcps.figma, enabledMcps.figmaConsole, enabledMcps.github]);

  // Build connected agents list for Temporal context (same logic as legacy body())
  const temporalConnectedAgents = useMemo(() =>
    clients
      .filter(c => c.clientId !== myClientId && c.type !== "overlay")
      .map(c => ({ shortId: c.shortId, label: c.label, type: c.type, fileName: c.figmaContext?.fileName })),
    [clients, myClientId]
  );

  // Extract instance IDs from TargetSelector (V2 path: instance:uuid format)
  const focusDesignInstanceId = selectedDesignTarget?.startsWith("instance:") ? selectedDesignTarget.slice(9) : undefined;
  const focusCodeInstanceId = selectedCodeTarget?.startsWith("instance:") ? selectedCodeTarget.slice(9) : undefined;

  // Extract plugin clientId from TargetSelector if the user selected a plugin
  // as design target. This allows figma_plugin_execute and Southleft cloud relay
  // pairing to work when the webapp runs in a regular browser tab (not inside
  // the Figma plugin iframe).
  const selectedDesignItem = designTargets.find((t) => t.id === selectedDesignTarget);
  const targetPluginClientId = selectedDesignItem?.kind === "plugin"
    ? selectedDesignItem.clientId
    : undefined;

  const chatWorkflow = useChatWorkflow({
    conversationId: activeConversationId,
    model: selectedModel || undefined,
    mcpServerIds: temporalMcpServerIds,
    // Priority: (1) plugin selected in TargetSelector → its clientId
    //           (2) webapp running inside Figma plugin iframe → own clientId
    //           (3) no plugin available → undefined (skips pairing + plugin execute)
    figmaPluginClientId: targetPluginClientId ?? (isFigmaPlugin ? myClientId : undefined),
    enabled: true,
    selectedNode,
    figmaPluginContext,
    connectedAgents: temporalConnectedAgents,
    isLocalPlugin: !!figmaPluginContext,
    source: selectedSource ?? undefined,
    keyId: selectedKeyId ?? undefined,
    designInstanceId: focusDesignInstanceId ?? undefined,
    codeInstanceId: focusCodeInstanceId ?? undefined,
  });

  // Chat variables — Temporal-only since the April 2026 cleanup.
  //
  // Casts to `UIMessage` / `UIMessage[]` preserve the shape the rest of
  // page.tsx was originally written against (back when the chat came from
  // `useChat`). `ChatMessage` from `useChatWorkflow` is structurally
  // compatible for the read paths used downstream (`.role`, `.parts`,
  // `.length`), and the cast is a compile-time no-op.
  const messages = chatWorkflow.messages as unknown as UIMessage[];
  const sendMessage = chatWorkflow.sendMessage;
  const cancelMessage = chatWorkflow.cancelMessage;
  const status = chatWorkflow.status === "idle" ? "ready" as const : "streaming" as const;
  const error = chatWorkflow.error ? new Error(chatWorkflow.error) : undefined;
  const setMessages = chatWorkflow.setMessages as unknown as (msgs: UIMessage[]) => void;

  // Clear error banner when switching conversations.
  useEffect(() => {
    setChatErrorMsg(null);
  }, [activeConversationId]);

  // Sync temporal chat errors to the PeekBanner error UI
  useEffect(() => {
    if (chatWorkflow.error) {
      setChatErrorMsg(chatWorkflow.error);
      setErrorCount((c) => c + 1);
    }
  }, [chatWorkflow.error]);

  // ── Message persistence ─────────────────────────────────────────────
  const getAssistantMetadata = useCallback(() => {
    const keyId = selectedKeyIdRef.current;
    const key = keyId ? byokKeysRef.current.find(k => k.id === keyId) : null;
    return {
      model: selectedModelRef.current || undefined,
      source: selectedSourceRef.current || undefined,
      keyId: keyId,
      keyLabel: key?.label ?? null,
      keyHint: key?.key_hint ?? null,
    };
  }, []);

  // Temporal chat persists messages server-side via `save_message` RPC and
  // `persistChatMessage` activity, so we no longer need the client-side
  // `useMessagePersistence` hook. `useChatWorkflow.loaded` replaces the old
  // `messagesLoaded` flag — it flips true after the hook's internal
  // `loadAndRecover` pass completes for the current conversation.
  const messagesLoaded = chatWorkflow.loaded;

  // ── Conversation switching handler ──────────────────────────────────
  // When switching away from the orchestration conversation, auto-release the role
  // so the user starts fresh in the new conversation (idle mode, [ORCHESTRATE:] available).
  const handleSwitchConversation = useCallback((id: string) => {
    switchConversation(id);
  }, [switchConversation]);

  const [errorVisible, setErrorVisible] = useState(false);
  useEffect(() => {
    if (error) setErrorVisible(true);
  }, [error]);

  // Keep a ref to messages to avoid stale closures in effects
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // ── Auto-rename conversation based on first user message ──────────
  const renamedConvIds = useRef(new Set<string>());

  useEffect(() => {
    if (!activeConversationId || !activeConversation) return;
    // Wait for the chat hook to finish loading the active conversation's messages.
    // Without this gate, switching to a brand-new conv would rename it using the
    // previous conv's first message (still in `messages` until the async load runs).
    if (!messagesLoaded) return;
    // Only rename conversations still titled "New conversation"
    if (activeConversation.title !== "New conversation") {
      renamedConvIds.current.add(activeConversationId);
      return;
    }
    if (renamedConvIds.current.has(activeConversationId)) return;

    // Find the first user message
    const firstUserMsg = messages.find((m) => m.role === "user");
    if (!firstUserMsg) return;

    // Wait until the assistant has responded (stream complete)
    const hasAssistantReply = messages.some((m) => m.role === "assistant");
    if (!hasAssistantReply || status !== "ready") return;

    // Mark as renamed to avoid re-triggering
    renamedConvIds.current.add(activeConversationId);

    // Extract title from first user message (first 60 chars, trimmed at word boundary)
    const text = firstUserMsg.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) return;

    const title = text.length <= 60 ? text : text.slice(0, 57).replace(/\s\S*$/, "") + "…";
    updateTitle(activeConversationId, title);
  }, [activeConversationId, activeConversation, messages, status, updateTitle, messagesLoaded]);

  // ── Reset event log on conversation switch ──
  const prevConvIdForLog = useRef(activeConversationId);
  // Track per-part states for granular logging: "msgId:partIndex" → last logged state
  const trackedParts = useRef<Map<string, string>>(new Map());
  const loggedUserMsgIds = useRef<Set<string>>(new Set());
  const prevMsgCount = useRef(0);
  const messagesLoadedFromDb = useRef(false);

  useEffect(() => {
    if (activeConversationId !== prevConvIdForLog.current) {
      prevConvIdForLog.current = activeConversationId;
      // Clear the timeline — it belongs to the current conversation only
      eventLog.current.length = 0;
      trackedParts.current.clear();
      loggedUserMsgIds.current.clear();
      prevMsgCount.current = 0;
      setMcpConnectionStatus("idle");
      // Reset orchestration state ONLY if we're NOT switching to/from the orchestration conversation.
      // Otherwise we'd kill the SSE stream the moment we auto-switch to the orchestration conv.
      const isOrchConv = orchConv.orchestrationConversationId === activeConversationId;
      const wasOrchConv = orchConv.orchestrationConversationId === prevConvIdForLog.current;
      if (!isOrchConv && !wasOrchConv && !orchConv.hasActiveOrchestration) {
        temporal.reset();
      }
    }
  }, [activeConversationId, eventLog, temporal, orchConv.orchestrationConversationId, orchConv.hasActiveOrchestration]);

  // ── Helpers for MCP_STATUS parsing and tool output ──

  /** Strip MCP_STATUS markers from text, return { clean, statuses } */
  const parseMcpStatus = useCallback((raw: string) => {
    const statuses: string[] = [];
    const re = /\[MCP_STATUS:(\w+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(raw)) !== null) statuses.push(match[1]);
    const clean = raw
      .replace(/\[MCP_STATUS:\w+\]/g, "")
      .replace(/\[MCP_ERROR_BLOCK\][\s\S]*?\[\/MCP_ERROR_BLOCK\]/g, "")
      .trim();
    return { clean, statuses };
  }, []);

  /** Parse MCP tool output: content[].text → JSON.parse when possible */
  const parseToolOutput = useCallback((output: unknown) => {
    if (output == null) return undefined;
    const o = output as { content?: { type: string; text: string }[] };
    if (o.content && Array.isArray(o.content)) {
      const text = o.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      try { return JSON.parse(text); } catch { return text; }
    }
    return output;
  }, []);

  // Helper: build grouped event data for history messages (loaded from DB)
  const buildHistoryMsgEvent = useCallback((m: { id: string; role: string; parts: { type: string; text?: string }[] }) => {
    const parts: unknown[] = [];
    for (const p of m.parts) {
      if (p.type === "text" && (p as { text?: string }).text) {
        const raw = (p as unknown as { text: string }).text;
        const { clean, statuses } = parseMcpStatus(raw);
        // Add MCP status parts
        for (const s of statuses) parts.push({ type: "mcp-status", status: s });
        // Add remaining text if any
        if (clean) parts.push({ type: "text", text: clean });
      } else if (p.type?.startsWith("tool-") || p.type === "dynamic-tool") {
        const tc = p as { type: string; toolName?: string; state?: string; input?: Record<string, unknown>; output?: unknown; errorText?: string };
        const name = tc.toolName ?? tc.type?.replace("tool-", "") ?? "unknown";
        const output = parseToolOutput(tc.output);
        parts.push({
          type: "tool",
          tool: name,
          state: tc.state,
          input: tc.input,
          ...(output !== undefined ? { output } : {}),
          ...(tc.errorText ? { error: tc.errorText } : {}),
        });
      }
    }
    return {
      dir: (m.role === "user" ? "out" : "in") as "in" | "out",
      channel: "chat" as const,
      type: `chat:history:${m.role}`,
      parts,
    };
  }, [parseMcpStatus, parseToolOutput]);

  // ── Track chat messages in the event log — granular per-part logging ──
  // Each part (tool state transition, text completion, MCP_STATUS) produces its
  // own timeline event with an accurate real-time timestamp.
  useEffect(() => {
    // Detect bulk load from DB: messages jumped from 0 to N (conversation switch)
    if (prevMsgCount.current === 0 && messages.length > 1) {
      messagesLoadedFromDb.current = true;
    }
    const newMsgs = messages.slice(prevMsgCount.current);
    const isHistory = messagesLoadedFromDb.current;
    // After processing the bulk load, switch back to live mode
    if (isHistory && newMsgs.length > 0) {
      messagesLoadedFromDb.current = false;
    }

    // ── New messages: user messages + history bulk load ──
    for (const m of newMsgs) {
      if (m.role === "user" && !loggedUserMsgIds.current.has(m.id)) {
        loggedUserMsgIds.current.add(m.id);
        const text = m.parts
          .filter((p: { type: string; text?: string }) => p.type === "text" && p.text)
          .map((p: { type: string; text?: string }) => (p as { text: string }).text)
          .join("\n");
        pushPluginEvent(eventLog.current, {
          dir: "out",
          channel: "chat",
          type: isHistory ? "chat:history:user" : "chat:user",
          parts: [{ type: "text", text }],
        });
      }
      if (m.role === "assistant" && isHistory) {
        // History assistant messages: log once as grouped entry
        loggedUserMsgIds.current.add(`hist:${m.id}`);
        const eventData = buildHistoryMsgEvent(m);
        pushPluginEvent(eventLog.current, eventData);
      }
    }
    prevMsgCount.current = messages.length;

    // ── Live assistant messages: granular per-part tracking ──
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      // Skip history messages (already handled above)
      if (loggedUserMsgIds.current.has(`hist:${m.id}`)) continue;

      for (let i = 0; i < m.parts.length; i++) {
        const p = m.parts[i] as { type: string; text?: string; state?: string; toolName?: string; input?: Record<string, unknown>; output?: unknown; errorText?: string };
        const key = `${m.id}:${i}`;
        const prevState = trackedParts.current.get(key);

        // ── Reasoning parts ──
        if (p.type === "reasoning") {
          const rp = p as { type: "reasoning"; text: string; state?: string };
          if (rp.text) {
            const reasoningState = rp.state;
            if ((reasoningState === "done" || status === "ready") && prevState !== "reasoning-done") {
              trackedParts.current.set(key, "reasoning-done");
              pushPluginEvent(eventLog.current, {
                dir: "in",
                channel: "chat",
                type: "chat:reasoning",
                parts: [{ type: "reasoning", text: rp.text }],
              });
            }
          }
        }

        // ── Text parts ──
        if (p.type === "text" && p.text) {
          const textState = (p as { state?: string }).state;
          // Log text when state becomes 'done' or when streaming finishes (status=ready)
          if ((textState === "done" || status === "ready") && prevState !== "done") {
            trackedParts.current.set(key, "done");
            const { clean, statuses } = parseMcpStatus(p.text);
            // Log MCP_STATUS as separate events + update header indicator
            for (const s of statuses) {
              pushPluginEvent(eventLog.current, {
                dir: "in",
                channel: "chat",
                type: "chat:mcp-status",
                summary: s,
              });
              if (s === "connecting" || s === "connected" || s === "error") {
                setMcpConnectionStatus(s);
              }
            }
            // Log actual text content (if any after stripping MCP markers)
            if (clean) {
              pushPluginEvent(eventLog.current, {
                dir: "in",
                channel: "chat",
                type: "chat:assistant:text",
                parts: [{ type: "text", text: clean }],
              });
            }
          }
        }

        // ── Tool parts ──
        if (p.type?.startsWith("tool-") || p.type === "dynamic-tool") {
          const currentState = p.state ?? "";
          if (currentState === prevState) continue; // no transition

          const name = p.toolName ?? p.type?.replace("tool-", "") ?? "unknown";

          if (currentState === "input-available" && prevState !== "input-available" && prevState !== "output-available" && prevState !== "output-error") {
            trackedParts.current.set(key, "input-available");
            pushPluginEvent(eventLog.current, {
              dir: "in",
              channel: "chat",
              type: "chat:tool:call",
              summary: name,
              parts: [{ type: "tool", tool: name, state: "input-available", input: p.input }],
            });
          }

          if (currentState === "output-available" && prevState !== "output-available") {
            trackedParts.current.set(key, "output-available");
            const output = parseToolOutput(p.output);

            // Extract execution metadata if present (from presence-aware figma-bridge)
            let execMeta: Record<string, unknown> | undefined;
            if (output && typeof output === "object" && "expectedClients" in output && Array.isArray((output as { result?: unknown }).result)) {
              const all = (output as { result: { clientId: string; success: boolean }[] }).result;
              const primary = all?.find((r: { success: boolean }) => r.success) ?? all?.[0];
              execMeta = {
                respondedBy: primary?.clientId,
                totalExecutions: all?.length ?? 0,
                expectedClients: (output as { expectedClients?: number }).expectedClients,
              };
            }

            pushPluginEvent(eventLog.current, {
              dir: "in",
              channel: "chat",
              type: "chat:tool:result",
              summary: name,
              parts: [{ type: "tool", tool: name, state: "output-available", input: p.input, ...(output !== undefined ? { output } : {}) }],
              ...(execMeta ? { meta: execMeta } : {}),
            });
          }

          if (currentState === "output-error" && prevState !== "output-error") {
            trackedParts.current.set(key, "output-error");
            pushPluginEvent(eventLog.current, {
              dir: "in",
              channel: "chat",
              type: "chat:tool:error",
              summary: name,
              parts: [{ type: "tool", tool: name, state: "output-error", ...(p.errorText ? { error: p.errorText } : {}) }],
            });
          }
        }
      }
    }
  }, [messages, status, eventLog, parseMcpStatus, parseToolOutput, buildHistoryMsgEvent]);

  // Wire the stable ref (declared early) to sendMessage now that it's available
  sendMessageEarlyRef.current = sendMessage;

  // Legacy orchestration callbacks removed — orchestration now runs on Temporal.

  // Inject fake agent message from plugin mini-mode tooltip
  // (user message sending is triggered separately via trigger-user-analysis)
  useEffect(() => {
    if (pendingAgentMessage !== null) {
      const text = pendingAgentMessage;
      setPendingAgentMessage(null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setMessages([...messagesRef.current, {
        id: `agent-prompt-${Date.now()}`,
        role: "assistant",
        parts: [{ type: "text", text: `${text} [ANALYZE_BTN]` }],
      }] as any);
    }
  }, [pendingAgentMessage]);

  const isLoading = status === "streaming";

  // Derive the current "thinking" phase + history for the PhaseBubble.
  // See packages/web/src/components/guardian/useGuardianPhase.ts for the
  // mapping from Temporal workflow state to phase types.
  const guardianPhase = useGuardianPhase(
    chatWorkflow.status,
    messages as unknown as Parameters<typeof useGuardianPhase>[1],
    chatWorkflow.workflowPhase,
    activeConversationId,
  );

  const handleScroll = () => {
    // While the rAF lerp is running, onScroll events are programmatic —
    // ignore them so the lerp's temporary gap (it's always slightly behind
    // target) doesn't flip shouldAutoScroll to false.
    if (scrollRafRef.current !== null) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const threshold = 80;
    shouldAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  // Wheel events are always user-initiated (never from programmatic scroll).
  // Detect scroll-up intent even while the rAF lerp is running and cancel it.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        shouldAutoScroll.current = false;
        if (scrollRafRef.current !== null) {
          cancelAnimationFrame(scrollRafRef.current);
          scrollRafRef.current = null;
        }
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);





  // Smooth scroll via rAF lerp. Each frame moves 18% of the remaining
  // distance toward the target (scrollHeight). At 60fps that's ~14
  // frames to cover 95% of any gap — fast enough to track streaming
  // line growth without the "jump" of instant scrollTop assignment, and
  // without CSS scroll-behavior: smooth which has a fixed ~300ms
  // duration that fights with the 50ms commit cadence.
  useLayoutEffect(() => {
    if (!shouldAutoScroll.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;

    const step = () => {
      scrollRafRef.current = null;
      const el2 = scrollContainerRef.current;
      if (!el2 || !shouldAutoScroll.current) return;

      const target = el2.scrollHeight - el2.clientHeight;
      const diff = target - el2.scrollTop;
      if (Math.abs(diff) < 1) {
        el2.scrollTop = target;
        return;
      }
      el2.scrollTop += diff * 0.18;
      scrollRafRef.current = requestAnimationFrame(step);
    };

    if (scrollRafRef.current === null) {
      scrollRafRef.current = requestAnimationFrame(step);
    }
  }, [messages]);

  // Orchestration panel scroll — same logic as chat panel
  const orchEvents = temporal.events;
  const orchPhase = useOrchestrationPhase(orchEvents, orchCompletedStatus);

  const handleOrchScroll = () => {
    const el = orchScrollContainerRef.current;
    if (!el) return;
    const threshold = 40;
    shouldAutoScrollOrch.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  // Same rationale as the chat panel above: useLayoutEffect synchronises the
  // auto-scroll with the DOM mutation to eliminate a visible intermediate frame.
  useLayoutEffect(() => {
    if (shouldAutoScrollOrch.current) {
      const el = orchScrollContainerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [orchEvents]);

  useEffect(() => {
    if (!isLoading) {
      inputRef.current?.focus();
    }
  }, [isLoading]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // While a workflow is running, `Enter` / submit is a no-op — the user
    // must press the dedicated Stop button (GuardianSendButton in generating
    // mode) to cancel first. Empty inputs are also ignored.
    if (!input.trim() || isLoading) return;
    shouldAutoScroll.current = true;
    shouldAutoScrollOrch.current = true;

    // If in an orchestration conversation and orchestration is active,
    // send as user input to the orchestrator instead of as a chat message.
    // Plugin: target this agent so the orchestrator routes the message correctly.
    if (orchConv.isInOrchestrationConversation && temporal.isActive) {
      const targetAgent = isFigmaPlugin ? myDisplayShortId : undefined;
      temporal.sendUserInput(input.trim(), targetAgent);
      setInput("");
      if (inputRef.current) inputRef.current.style.height = "auto";
      return;
    }

    sendMessage({ text: input });
    setInput("");
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  };

  const figmaConnected = figmaOAuth || figmaAccessToken.trim().length > 0 || (figmaMcpUrl?.trim().length ?? 0) > 0;
  const codeConnected = (codeProjectPath?.trim().length ?? 0) > 0;

  // Function to detect the MCP connection mode
  const getMcpConnectionMode = (url: string): { mode: 'direct' | 'proxy-local' | 'proxy-online'; label: string; color: string } => {
    if (!url) return { mode: 'direct', label: 'Not configured', color: 'text-white/40' };

    if (url.includes('trycloudflare.com') || url.includes('ngrok') || (url.startsWith('https://') && !url.includes('localhost'))) {
      return { mode: 'proxy-online', label: '🔵 Proxy Online', color: 'text-blue-400' };
    }

    if (url.includes('/proxy-local/') || url.includes('localhost:3000/proxy-local')) {
      return { mode: 'proxy-local', label: '🟢 Proxy Local', color: 'text-amber-400' };
    }

    return { mode: 'direct', label: '⚪ Direct', color: 'text-white/60' };
  };

  const figmaMode = getMcpConnectionMode(figmaMcpUrl || (figmaOAuth ? "https://mcp.figma.com/mcp" : ""));
  const codeMode = getMcpConnectionMode(codeProjectPath || "");

  // ── Settings content removed — MCP connections managed in Account page ──
  // TODO(Phase 4 follow-up): clean up dead state vars (figmaOAuth, enabledMcps, etc.)

    const hasBannerPad = orchConv.isRelatedToOrchestration;
    const headerPaddingClass = (() => {
      const base = agentRole !== "idle" && mcpConnectionStatus !== "idle"
        ? "pt-[7rem]"
        : agentRole !== "idle"
        ? "pt-[5.5rem]"
        : mcpConnectionStatus !== "idle"
        ? "pt-[5rem]"
        : "pt-16";
      const withBanner = agentRole !== "idle" && mcpConnectionStatus !== "idle"
        ? "pt-[9rem]"
        : agentRole !== "idle"
        ? "pt-[7.5rem]"
        : mcpConnectionStatus !== "idle"
        ? "pt-[7rem]"
        : "pt-[5.5rem]";
      return hasBannerPad ? withBanner : base;
    })();

    return (
    <div className="relative flex h-screen text-white overflow-hidden">
      {/* Background provided by root layout — no local copy needed */}
      {/* Mobile backdrop — dim only, blur comes from the sidebar's own glass-sidebar */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden bg-black/30"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* Sidebar — mobile: fixed full-width drawer, desktop: relative column */}
      <div className={`${
        sidebarOpen
          ? "fixed top-0 left-0 z-50 w-full sm:w-72 h-full translate-x-0"
          : "fixed top-0 left-0 z-50 w-full sm:w-72 h-full -translate-x-full"
      } ${sidebarCollapsed ? "md:w-12" : "md:w-72"} md:relative md:top-auto md:left-auto md:z-10 md:h-full md:translate-x-0 transition-all duration-200 glass-sidebar`}>
        <ConversationSidebar
          conversations={conversations}
          activeId={activeConversationId}
          onSwitch={(id) => { handleSwitchConversation(id); setSidebarOpen(false); }}
          onCreate={() => { createConversation(); setSidebarOpen(false); }}
          onDelete={deleteConversation}
          onRename={renameConversation}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
          childrenMap={childrenMap}
          activeWorkflowId={temporal.isActive ? temporal.workflowId : null}
        />
      </div>

      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Background provided by root layout — backdrop-filter sees through to the fixed layer */}
        <header className="absolute top-0 left-0 right-0 z-20 flex flex-col" style={{ background: "rgba(10,10,10,0.3)", backdropFilter: "blur(6px) saturate(1.3)", boxShadow: "0 4px 24px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.06) inset" }}>
          <div className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-white/30">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              onClick={toggleSidebar}
              className="p-2 rounded-md hover:bg-white/5 transition-colors shrink-0 cursor-pointer"
              title="Toggle sidebar"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 12h18M3 6h18M3 18h18" />
              </svg>
            </button>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold truncate">Guardian</h1>
              <p className="text-xs text-white/65 hidden sm:block">
                [Design ↔ Code] Design System Guardian
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {/* Active conversation title indicator */}
            <span className="text-xs text-white/50 truncate max-w-[160px] hidden sm:inline">
              {activeConversation?.title ?? "New conversation"}
            </span>
            <EditableClientId
              shortId={myDisplayShortId}
              onRenamed={async (newShortId) => {
                const ok = await renameClient(newShortId);
                if (ok) setRegistryShortId(newShortId);
                return ok;
              }}
            />
            <div className="w-px h-4 bg-white/10 mx-1 hidden sm:block" />
            <UserMenu />
          </div>
          </div>
          {temporal.isActive && (
            <OrchestrationStatusBar
              role="orchestrator"
              collaborators={temporal.agents.map(a => ({
                clientId: a.shortId,
                shortId: a.shortId,
                label: a.label || a.shortId,
                status: a.status === "completed" ? "completed" : "active",
              }))}
              timerRemainingMs={temporal.timerRemainingMs}
              onCancel={() => temporal.stopOrchestration()}
            />
          )}
          {temporal.error && (
            <div className="px-4 py-2 text-xs text-red-400 bg-red-500/10 border-b border-red-500/20">
              Orchestration error: {temporal.error}
            </div>
          )}
          {temporal.streamError && (
            <div className="px-4 py-2 text-xs text-orange-400 bg-orange-500/10 border-b border-orange-500/20">
              Stream: {temporal.streamError}
            </div>
          )}
          <MCPStatusBar status={mcpConnectionStatus} />

          {/* Unified orchestration banner — visible on related conversations (webapp + plugin) */}
          {orchConv.isRelatedToOrchestration && (
            <OrchestrationBanner
              active={temporal.isActive || !!temporal.completedStatus}
              isInOrchestrationConversation={orchConv.isInOrchestrationConversation}
              onView={orchConv.switchToOrchestration}
              onBack={orchConv.switchBackToChat}
              timerRemainingMs={temporal.timerRemainingMs}
              completedStatus={temporal.completedStatus}
              errorMessage={temporal.streamError}
              viewMode={orchViewMode}
              onToggleViewMode={() => {
                const next = orchViewMode === "chat" ? "developer" : "chat";
                setOrchViewMode(next);
                localStorage.setItem("guardian:orchViewMode", next);
              }}
              agents={temporal.agents}
            />
          )}
        </header>


        {/* Slide container — holds the two sliding panels (chat + orchestration).
            overflow-hidden used to live here, but it was clipping the composer's
            aurora halo at the slide container's left/right edges. The slider's
            off-screen panel is still clipped by the root's h-screen overflow-hidden
            at the viewport boundary, so removing it here is safe visually. */}
        <div className="relative flex-1">
          <div
            className="flex h-full transition-transform duration-150 ease-in-out"
            style={{ transform: showOrchPanel ? "translateX(-100%)" : "translateX(0)" }}
          >
            {/* ── Left panel: Normal chat conversation ── */}
            <div className="min-w-full h-full relative">
            <div ref={scrollContainerRef} onScroll={handleScroll} className={`absolute inset-0 overflow-y-auto px-3 sm:px-4 pb-56 ${headerPaddingClass}`}>
              {/* Chat panel content starts here */}
          {messages.length === 0 && messagesLoaded && (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <img src="/guardian-logo.svg" alt="Guardian" className="h-12 mx-auto mb-4" />
              <h2 className="text-lg font-semibold mb-2">
                Welcome to Guardian
              </h2>
              <p className="text-sm text-white/70 max-w-md mb-6">
                I can compare your Figma design system components with their
                code implementation to detect property and variant drift.
              </p>

              {/* Free tier onboarding notice */}
              {byokKeys.length === 0 && (
                <div className="mb-6 w-full max-w-sm rounded-xl bg-white/[0.07] border border-white/[0.15] p-4 text-left">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0 w-7 h-7 rounded-full bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-sm">
                      ✨
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white/90 mb-1">You&apos;re on the free tier</p>
                      <p className="text-xs text-white/60 leading-relaxed mb-3">
                        You get 250k tokens per day on us (rolling 24h window). Each message uses the platform&apos;s AI model.
                      </p>
                      <div className="space-y-2">
                        <p className="text-[11px] text-white/65 font-medium uppercase tracking-wider">Want unlimited access?</p>
                        <div className="space-y-1.5 text-xs text-white/55">
                          <div className="flex items-start gap-2">
                            <span className="shrink-0 mt-0.5">1.</span>
                            <span>
                              Create a free{" "}
                              <a href="https://vercel.com/ai-gateway" target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-300 underline underline-offset-2">
                                Vercel AI Gateway
                              </a>{" "}
                              account — one key to access 100+ AI models
                            </span>
                          </div>
                          <div className="flex items-start gap-2">
                            <span className="shrink-0 mt-0.5">2.</span>
                            <span>Or add your own OpenAI, Anthropic, or Google API key</span>
                          </div>
                        </div>
                        <Link
                          href="/account"
                          className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-lg bg-violet-600/20 border border-violet-500/30 text-xs text-violet-300 hover:bg-violet-600/30 transition-colors"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                          Add an API key
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2 text-sm text-white/60">
                <p>Try asking:</p>
                <button
                  onClick={() => sendMessage({ text: "What i can do With guardian ?" })}
                  className="block mx-auto px-3 py-1.5 rounded-md bg-white/8 border border-white/10 hover:bg-white/15 transition-colors cursor-pointer text-white/75"
                >
                  &quot;What i can do With guardian ?&quot;
                </button>
                <button
                  onClick={() => sendMessage({ text: "Show me a demo of your features" })}
                  className="block mx-auto px-3 py-1.5 rounded-md bg-white/8 border border-white/10 hover:bg-white/15 transition-colors cursor-pointer text-white/75"
                >
                  &quot;Show me a demo of your features&quot;
                </button>
              </div>
            </div>
          )}

          {messages.filter((m, idx, arr) => {
            // Deduplicate by ID (keep last occurrence — most complete from streaming)
            if (arr.findLastIndex(x => x.id === m.id) !== idx) return false;
            // Skip empty assistant messages (only MCP_STATUS markers, no real content)
            if (m.role === "assistant") {
              // Keep messages that have tool calls (dynamic-tool parts)
              const hasToolParts = m.parts?.some((p) => (p as { type: string }).type === "dynamic-tool");
              if (hasToolParts) return true;
              const stripped = m.parts
                ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
                .map(p => p.text)
                .join("")
                .replace(/\[MCP_STATUS:\w+\]/g, "")
                .trim();
              if (!stripped) return false;
            }
            return true;
          }).map((m, mi) => {
            // Detect inter-agent messages (injected by orchestration hooks)
            const msgText = m.parts?.find((p): p is { type: "text"; text: string } => p.type === "text")?.text ?? "";
            const agentJoinMatch = msgText.match(/^Agent (#[\w-]+) \((.+?)\) has joined/);
            // Match all agent report formats: [Agent report from ...], [Agent progress update from ...], [Agent final report from ...]
            const agentReportMatch = msgText.match(/^\[Agent (?:report|progress update|final report) from (#[\w-]+)\] ([\s\S]*)/);
            // Match relay messages: [Message from #shortId] ...
            const agentMsgMatch = !agentReportMatch && msgText.match(/^\[Message from (#?[\w-]+)\] ([\s\S]*)/);
            // Match orchestrator task injection: [Orchestrator task] ...
            const orchTaskMatch = !agentReportMatch && !agentMsgMatch && msgText.match(/^\[Orchestrator task\]/);
            // Match system messages (watchdog, nudges): [System ...] ...
            const systemMsgMatch = !agentReportMatch && !agentMsgMatch && !orchTaskMatch && msgText.match(/^\[System[^\]]*\] ([\s\S]*)/);
            // Match collaborator join notifications: [#agent1 (file A), #agent2 (file B) joined the session ...]
            const collabJoinMatch = !agentReportMatch && !agentMsgMatch && !orchTaskMatch && !systemMsgMatch
              && msgText.match(/^\[(.+?) joined the session/);

            if (m.role === "user" && (agentJoinMatch || agentReportMatch || agentMsgMatch || orchTaskMatch || systemMsgMatch || collabJoinMatch)) {
              if (agentJoinMatch) {
                return (
                  <div key={m.id} className="flex justify-center my-2">
                    <div className="px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/15 text-[11px] text-emerald-400/70">
                      <span className="font-medium">{agentJoinMatch[1]}</span> ({agentJoinMatch[2]}) joined the session
                    </div>
                  </div>
                );
              }
              if (collabJoinMatch) {
                // Parse agent list: "#Agent1 (file A), #Agent2 (file B)"
                const agentList = collabJoinMatch[1].split(/,\s*/).map(a => a.trim());
                return (
                  <div key={m.id} className="flex justify-center my-2">
                    <div className="px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/15 text-[11px] text-emerald-400/70">
                      {agentList.map((agent, i) => (
                        <span key={i}>{i > 0 && ", "}<span className="font-medium">{agent}</span></span>
                      ))}
                      {" "}joined the session
                    </div>
                  </div>
                );
              }
              if (agentReportMatch) {
                return (
                  <div key={m.id} className="mb-3">
                    <AgentMessageBubble
                      senderShortId={agentReportMatch[1]}
                      content={agentReportMatch[2]}
                      isOrchestrator={false}
                    />
                  </div>
                );
              }
              if (agentMsgMatch) {
                return (
                  <div key={m.id} className="mb-3">
                    <AgentMessageBubble
                      senderShortId={agentMsgMatch[1]}
                      content={agentMsgMatch[2]}
                      isOrchestrator={false}
                    />
                  </div>
                );
              }
              if (orchTaskMatch) {
                return (
                  <div key={m.id} className="flex justify-center my-2">
                    <div className="px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/15 text-[11px] text-amber-400/70">
                      Task assigned by orchestrator
                    </div>
                  </div>
                );
              }
              if (systemMsgMatch) {
                return (
                  <div key={m.id} className="flex justify-center my-2">
                    <div className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-white/40 italic">
                      {systemMsgMatch[1]}
                    </div>
                  </div>
                );
              }
            }

            return (
            <div
              key={m.id}
              className={`group mb-4 ${m.role === "user" ? "flex justify-end" : ""}`}
            >
              <div className="max-w-full sm:max-w-[80%] inline-block">
              <div
                className={`rounded-lg px-3 sm:px-4 py-2.5 sm:py-3 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "glass-msg-user"
                    : "glass-msg-ai"
                }`}
              >
                {m.parts?.map((part, i) => {
                  // ── Render tool invocations (figma_plugin_execute + MCP tools) ──
                  if (part.type?.startsWith("tool-")) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const toolPart = part as any;
                    // Tool name is encoded in the type: "tool-figma_plugin_execute"
                    const toolName: string = part.type.replace(/^tool-/, "");
                    const toolDisplayName = toolName === "figma_plugin_execute"
                      ? "Figma Plugin Tool"
                      : toolName.replace(/_/g, " ");
                    const state: string = toolPart.state ?? "";
                    const isRunning = state === "input-available" || state === "input-streaming";
                    const hasResult = state === "output-available";
                    const hasError = state === "output-error" || state === "output-denied";
                    const inputData = toolPart.input as Record<string, unknown> | undefined;
                    const outputData = toolPart.output as { success?: boolean; result?: unknown; error?: string } | undefined;
                    const errorText: string = toolPart.errorText ?? "";
                    const isSuccess = hasResult && outputData?.success !== false;

                    return (
                      <div key={i} className="my-2">
                        <div className={`flex items-center gap-2 text-xs px-3 py-2 rounded-md border transition-colors ${
                          isRunning
                            ? "bg-blue-500/10 border-blue-500/20 text-blue-300"
                            : hasError || (hasResult && !isSuccess)
                            ? "bg-red-500/10 border-red-500/20 text-red-300"
                            : hasResult
                            ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-300"
                            : "bg-white/5 border-white/10 text-white/50"
                        }`}>
                          {/* Tool icon */}
                          {isRunning ? (
                            <svg className="animate-spin h-3 w-3 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                              {isSuccess ? <path d="M20 6L9 17l-5-5" /> : hasError ? <path d="M18 6L6 18M6 6l12 12" /> : <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />}
                            </svg>
                          )}
                          <span className="font-medium">{toolDisplayName}</span>
                          {isRunning && <span className="opacity-60">running...</span>}
                          {isSuccess && <span className="opacity-60">done</span>}
                          {(hasError || (hasResult && !isSuccess)) && (
                            <span className="opacity-60 truncate max-w-[200px]">{errorText || outputData?.error || "failed"}</span>
                          )}
                        </div>
                        {/* Show code snippet for figma_plugin_execute */}
                        {toolName === "figma_plugin_execute" && !!inputData?.code && (
                          <details className="mt-1 ml-5">
                            <summary className="text-[10px] text-white/30 cursor-pointer hover:text-white/50">Show code</summary>
                            <pre className="mt-1 px-2 py-1.5 rounded text-[10px] bg-black/30 text-white/50 overflow-x-auto max-h-32 overflow-y-auto">
                              {String(inputData.code).substring(0, 500)}
                            </pre>
                          </details>
                        )}
                        {/* Show result snippet */}
                        {hasResult && outputData != null && (
                          <details className="mt-1 ml-5">
                            <summary className="text-[10px] text-white/30 cursor-pointer hover:text-white/50">Show result</summary>
                            <pre className="mt-1 px-2 py-1.5 rounded text-[10px] bg-black/30 text-white/50 overflow-x-auto max-h-32 overflow-y-auto">
                              {JSON.stringify(outputData, null, 2).substring(0, 500)}
                            </pre>
                          </details>
                        )}
                      </div>
                    );
                  }

                  if (part.type === "reasoning") {
                    const rp = part as { type: "reasoning"; text: string; state?: string };
                    if (!rp.text) return null;
                    const isLastMsg = m === messages[messages.length - 1];
                    return (
                      <ThinkingBlock
                        key={i}
                        text={rp.text}
                        isLast={isLastMsg}
                        isStreaming={isLoading && rp.state === "streaming"}
                      />
                    );
                  }

                  if (part.type === "text") {
                    const isLastMsg = m === messages[messages.length - 1];
                    const cleanText = part.text.replace("[CONTINUATION_AVAILABLE]", "");
                    const structuredSegments = parseStructuredContent(cleanText, isLoading && isLastMsg);

                    return (
                      <div key={i}>
                        {structuredSegments.map((structSeg, sj) => {
                          if (structSeg.kind === "details") {
                            return <DetailsBlock key={sj} text={structSeg.text} isStreaming={structSeg.streaming} />;
                          }
                          if (structSeg.kind === "qcm") {
                            return <QCMBlock key={sj} choices={structSeg.choices} onSelect={(choice) => { shouldAutoScroll.current = true; sendMessage({ text: choice }); }} disabled={isLoading} />;
                          }
                          if (structSeg.kind === "mcp-error") {
                            return (
                              <MCPErrorBlock
                                key={sj}
                                errorText={structSeg.errorText}
                                onAskHelp={() => {
                                  shouldAutoScroll.current = true;
                                  sendMessage({
                                    text: `I'm having trouble connecting to the MCP servers. Can you help me troubleshoot this error?\n\nError details:\n${structSeg.errorText}`,
                                  });
                                }}
                              />
                            );
                          }
                          if (structSeg.kind === "mcp-status") {
                            return null; // MCP status now rendered as header bar (MCPStatusBar)
                          }
                          if (structSeg.kind === "analyze-btn") {
                            return (
                              <button
                                key={sj}
                                onClick={() => { shouldAutoScroll.current = true; sendMessage({ text: "Yes analyze my new figma selection" }); }}
                                disabled={isLoading}
                                title="Analyze with AI"
                                className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-blue-500 hover:bg-blue-400 text-white transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ml-1 mt-1 hover:scale-110 hover:shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M12 2.5c0 0 .9 4 2.8 5.5C16.7 9.5 21 9.5 21 9.5s-4.3.1-6.2 1.6C12.9 12.5 12 16.5 12 16.5s-.9-4-2.8-5.5C7.3 9.6 3 9.5 3 9.5s4.3 0 6.2-1.5C11.1 6.5 12 2.5 12 2.5z"/>
                                  <path d="M19.5 15c0 0 .5 2 1.5 2.7 1 .7 2.5.8 2.5.8s-1.5 0-2.5.8c-1 .7-1.5 2.7-1.5 2.7s-.5-2-1.5-2.7c-1-.7-2.5-.8-2.5-.8s1.5-.1 2.5-.8c1-.7 1.5-2.7 1.5-2.7z"/>
                                </svg>
                              </button>
                            );
                          }
                          if (structSeg.kind === "orchestrate-btn") {
                            // Determine button state: check if a collab sub-conversation exists for this conversation
                            const childCollabs = childrenMap.get(activeConversationId ?? "") ?? [];
                            // Active collab (temporal is running now)
                            const activeCollab = temporal.isActive && temporal.workflowId
                              ? childCollabs.find(c => (c.metadata as Record<string, unknown>)?.workflowId === temporal.workflowId)
                              : null;
                            // Most recent completed collab (if no active one)
                            const completedCollab = !activeCollab
                              ? childCollabs.filter(c => (c.metadata as Record<string, unknown>)?.workflowId).at(-1)
                              : null;

                            // State: in-progress
                            if (activeCollab || (temporal.isActive && temporal.workflowId)) {
                              return (
                                <button
                                  key={sj}
                                  onClick={() => orchConv.switchToOrchestration()}
                                  className="my-3 flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-all cursor-pointer bg-amber-500/15 border-amber-500/30 text-amber-300 hover:bg-amber-500/25 animate-pulse"
                                >
                                  <svg className="animate-spin h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                  </svg>
                                  Collab in progress...
                                  {temporal.timerRemainingMs != null && (
                                    <span className="text-xs text-amber-400/50 ml-1">
                                      {Math.round((temporal.totalDurationMs - temporal.timerRemainingMs) / 1000)}s
                                    </span>
                                  )}
                                </button>
                              );
                            }

                            // State: completed (a past collab exists for this conversation)
                            if (completedCollab) {
                              return (
                                <button
                                  key={sj}
                                  onClick={() => {
                                    handleSwitchConversation(completedCollab.id);
                                  }}
                                  className="my-3 flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-all cursor-pointer bg-emerald-500/10 border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/20 hover:border-emerald-500/40"
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                                    <path d="M20 6L9 17l-5-5" />
                                  </svg>
                                  Collab completed
                                  <span className="text-xs text-emerald-400/50 ml-1">({structSeg.agents.join(", ")})</span>
                                </button>
                              );
                            }

                            // State: not started (default)
                            return (
                              <button
                                key={sj}
                                onClick={async () => {
                                  if (temporal.isActive) return;
                                  const lastUserText = messagesRef.current.filter(m => m.role === "user").map(m => m.parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map(p => p.text).join(" ")).pop() || "Collaborative task";
                                  // Build target agents from suggested agent shortIds
                                  const targetAgents = structSeg.agents
                                    .map((agentShortId: string) => clients.find(c => c.shortId === agentShortId && c.clientId !== myClientId))
                                    .filter((c): c is typeof clients[number] => !!c)
                                    .map((c) => ({
                                      shortId: c.shortId,
                                      workflowId: "",
                                      label: c.label,
                                      type: c.type as "figma-plugin" | "web",
                                      fileName: c.figmaContext?.fileName,
                                      pluginClientId: c.clientId,
                                    }));
                                  if (targetAgents.length === 0) { console.warn("[ORCHESTRATE] No matching agents found — aborting"); return; }
                                  await temporal.startOrchestration({
                                    task: lastUserText,
                                    targetAgents,
                                    model: selectedModel,
                                    // Attach to the current chat so the sub-conv
                                    // is a child of this conversation, not an
                                    // orphan parent created server-side.
                                    conversationId: activeConversationId ?? undefined,
                                  });
                                }}
                                disabled={isLoading || temporal.isActive || temporal.starting}
                                className="my-3 flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-all cursor-pointer bg-amber-500/10 border-amber-500/25 text-amber-300 hover:bg-amber-500/20 hover:border-amber-500/40 disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                                  <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M3 4l17 17" />
                                </svg>
                                Start Collaborative Mode
                                <span className="text-xs text-amber-400/50 ml-1">({structSeg.agents.join(", ")})</span>
                              </button>
                            );
                          }

                          // content kind
                          const imageSegments = parseTextWithImages(structSeg.text, isLoading && isLastMsg);
                          return (
                            <div key={sj} className="markdown-body overflow-x-auto">
                              {imageSegments.map((seg, j) =>
                                seg.type === "image" ? (
                                  !seg.complete ? (
                                    <div key={j} className="my-3 flex flex-col items-center justify-center w-full max-w-64 h-48 bg-white/5 border border-white/10 rounded-lg">
                                      <svg className="animate-spin h-8 w-8 text-white/30 mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                      </svg>
                                      <span className="text-xs text-white/30">Loading image…</span>
                                    </div>
                                  ) : (
                                    <img
                                      key={j}
                                      src={seg.src}
                                      alt="Generated image"
                                      className="my-3 max-w-full rounded-lg border border-white/10"
                                    />
                                  )
                                ) : isLoading && isLastMsg && m.role === "assistant" ? (
                                  // Streaming bubble: use <StreamingMarkdown> which
                                  // splits the content into a memoized stable zone
                                  // (rendered once per paragraph) and a small fresh
                                  // tail that goes through per-char span wrapping.
                                  // This keeps the hot path bounded to ~100 chars
                                  // regardless of total message length.
                                  <StreamingMarkdown key={j} content={seg.content} />
                                ) : (
                                  // Finalized message — plain markdown, no spans.
                                  <ReactMarkdown
                                    key={j}
                                    remarkPlugins={[remarkGfm]}
                                    components={markdownComponents}
                                  >
                                    {fixUnpairedMarkdown(seg.content)}
                                  </ReactMarkdown>
                                )
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  }
                  // Recovering skeleton — shown during F5 recovery gap (Temporal chat)
                  if ((part as { type: string }).type === "recovering-skeleton") {
                    return (
                      <div key={i} className="mt-3 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="relative flex h-5 w-5 items-center justify-center">
                            <span className="absolute h-5 w-5 rounded-full border-2 border-blue-400/30 border-t-blue-400 animate-spin" />
                          </div>
                          <div>
                            <div className="text-sm font-medium text-blue-300/90">Reconnecting to stream</div>
                            <div className="text-xs text-blue-300/50 mt-0.5">Recovering response in progress...</div>
                          </div>
                        </div>
                        <div className="mt-2 space-y-1.5">
                          <div className="h-3 w-full rounded bg-white/5 animate-pulse" />
                          <div className="h-3 w-4/5 rounded bg-white/5 animate-pulse" style={{ animationDelay: "150ms" }} />
                          <div className="h-3 w-3/5 rounded bg-white/5 animate-pulse" style={{ animationDelay: "300ms" }} />
                        </div>
                      </div>
                    );
                  }
                  // Typed tool calls from the Responses API (e.g.: tool-web_search)
                  if (part.type?.startsWith("tool-")) {
                    const toolName = part.type.replace("tool-", "");
                    const p = part as { type: string; toolCallId: string; state: string; input?: Record<string, unknown>; output?: unknown; errorText?: string; providerExecuted?: boolean };

                    // If the provider executed the tool but we haven't received output-available,
                    // we consider it done when we receive text after
                    const hasTextAfter = m.parts?.slice(i + 1).some((nextPart: { type?: string }) => nextPart.type === "text");
                    const isProviderExecuted = (p as unknown as { providerExecuted?: boolean }).providerExecuted === true;

                    // If providerExecuted=true, the tool is done (executed server-side by xAI)
                    // We don't wait for output-available which never arrives for native xAI tools
                    if (isProviderExecuted || p.state === "output-available") {
                      return (
                        <ToolCallBlock
                          key={i}
                          toolName={toolName}
                          input={p.input}
                          output={p.output || { content: [{ type: "text", text: "Result integrated in the response" }] }}
                          isError={false}
                        />
                      );
                    }

                    switch (p.state) {
                      case "input-streaming":
                      case "input-available":
                        return <ToolCallProgress key={i} toolName={toolName} input={p.input} />;
                      case "output-available":
                        return (
                          <ToolCallBlock
                            key={i}
                            toolName={toolName}
                            input={p.input}
                            output={p.output}
                            isError={false}
                          />
                        );
                      case "output-error":
                        return (
                          <ToolCallBlock
                            key={i}
                            toolName={toolName}
                            input={p.input}
                            output={{ isError: true, content: [{ type: "text", text: p.errorText || "Unknown error" }] }}
                            isError={true}
                          />
                        );
                      default:
                        return <ToolCallProgress key={i} toolName={toolName} input={p.input} />;
                    }
                  }
                  if ((part as { type: string }).type === "dynamic-tool") {
                    const p = part as { type: string; toolName: string; state: string; input?: Record<string, unknown>; output?: { content?: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean }; errorText?: string; providerExecuted?: boolean };

                    // If the provider executed the tool but we haven't received output-available,
                    // we consider it done when we receive text after
                    const hasTextAfter = m.parts?.slice(i + 1).some((nextPart: { type?: string }) => nextPart.type === "text");
                    const isProviderExecuted = p.providerExecuted === true;

                    // If providerExecuted=true, the tool is done (executed server-side by xAI)
                    // We don't wait for output-available which never arrives for native xAI tools
                    if (isProviderExecuted || p.state === "output-available") {
                      return (
                        <ToolCallBlock
                          key={i}
                          toolName={p.toolName}
                          input={p.input}
                          output={p.output || { content: [{ type: "text", text: "Result integrated in the response" }] }}
                          isError={p.output?.isError}
                        />
                      );
                    }

                    // Handle all possible tool call states
                    switch (p.state) {
                      case "input-streaming":
                      case "input-available":
                        return <ToolCallProgress key={i} toolName={p.toolName} input={p.input} />;
                      case "output-available":
                        return (
                          <ToolCallBlock
                            key={i}
                            toolName={p.toolName}
                            input={p.input}
                            output={p.output}
                            isError={p.output?.isError}
                          />
                        );
                      case "output-error":
                      case "error":
                        return (
                          <ToolCallBlock
                            key={i}
                            toolName={p.toolName}
                            input={p.input}
                            output={p.output?.isError ? p.output : { isError: true, content: [{ type: "text", text: p.errorText || p.output?.content?.[0]?.text || "Unknown error" }] }}
                            isError={true}
                          />
                        );
                      default:
                        return <ToolCallProgress key={i} toolName={p.toolName} input={p.input} />;
                    }
                  }
                  return null;
                })}
              </div>
              <div className={`flex mt-1 ${m.role === "user" ? "justify-end" : ""}`}>
                <button
                  onClick={() => {
                    const textParts = m.parts
                      ?.filter((p: { type: string; text?: string }) => p.type === "text" && p.text)
                      .map((p: { type: string; text?: string }) => p.text)
                      .join("\n")
                      .replace(/\[MCP_STATUS:\w+\]/g, "")
                      .replace(/\[MCP_ERROR_BLOCK\][\s\S]*?\[\/MCP_ERROR_BLOCK\]/g, "")
                      .replace(/\[ORCHESTRATE:[^\]]+\]/g, "")
                      .replace(/\[AGENT_DONE:[^\]]*\]/g, "")
                      .replace(/\[CONTINUATION_AVAILABLE\]/g, "")
                      .replace(/\[ANALYZE_BTN\]/g, "")
                      .trim() || "";
                    // For tool call messages, include tool name + input/output
                    const toolParts = m.parts
                      ?.filter((p: { type: string }) => (p as { type: string }).type === "dynamic-tool")
                      .map((p: unknown) => {
                        const t = p as { toolName: string; input?: Record<string, unknown>; output?: { content?: { text: string }[] }; state: string };
                        const input = t.input ? JSON.stringify(t.input, null, 2) : "{}";
                        const output = t.output?.content?.map(c => c.text).join("\n") ?? t.state;
                        return `Tool: ${t.toolName}\nInput: ${input}\nOutput: ${output}`;
                      })
                      .join("\n\n") || "";
                    copyToClipboard([textParts, toolParts].filter(Boolean).join("\n\n"));
                  }}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-white/15 hover:text-white/50 hover:bg-white/5 transition-colors cursor-pointer"
                  title="Copy message"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                </button>
              </div>
              {m === messages[messages.length - 1] && m.role === "assistant" && !isLoading && m.parts?.some(part => part.type === "text" && part.text.includes("[CONTINUATION_AVAILABLE]")) && (
                <button
                  onClick={() => {
                    shouldAutoScroll.current = true;
                    sendMessage({ text: "Continue your last truncated message" });
                  }}
                  className="mt-2 px-3 py-1.5 text-xs rounded-md bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 hover:text-blue-200 transition-colors cursor-pointer"
                >
                  Continue the response
                </button>
              )}
              </div>
            </div>
          );
          })}

          {/* PhaseBubble moved to the stacked banner area above the composer */}

          {/* Copy debug context button — always visible after all messages */}
          {messages.length > 0 && !isLoading && (
            <CopyDebugButton
              messages={messages}
              clients={clients}
              myClientId={myClientId}
              myShortId={myDisplayShortId}
              agentRole={agentRole}
              orchestration={orchestration}
              collaborators={collaborators}
              activeConversationId={activeConversationId}
              conversations={conversations}
              model={selectedModel}
              chatStatus={status}
              chatError={error}
              enabledMcps={enabledMcps}
              mcpReachable={mcpReachable}
              isFigmaPlugin={isFigmaPlugin}
              figmaContext={figmaContext}
              selectedNodeCount={selectedNode?.nodes?.length ?? 0}
              eventLog={eventLog.current}
              temporalOrchestration={{
                workflowId: temporal.workflowId,
                isActive: temporal.isActive,
                completedStatus: temporal.completedStatus,
                agents: temporal.agents,
                events: temporal.events,
                connected: temporal.connected,
                streamError: temporal.streamError,
                timerRemainingMs: temporal.timerRemainingMs,
              }}
              pushTrace={pushTrace}
              fetchUnifiedDebug={fetchUnifiedDebug}
            />
          )}

          {/* Selection changed block — disabled for now */}

          {error && errorVisible && error?.message?.includes("429") && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400 break-words">
              Daily free tier limit reached. <a href="/account" className="underline hover:text-red-300">Add your own API key</a> for unlimited access.
            </div>
          )}

          <div ref={messagesEndRef} />
            </div>
            {/* ── Chat input form (inside the chat panel) ──
                 Note: no z-index on this container. The composer-aurora halo
                 inside drops to z-index: -1 so the scroll container (and its
                 translucent scrollbar) paints above it — exactly like the
                 app's animated background. The form inside keeps its own
                 z-10 via its inline className so it stays above everything
                 else in the slider's stacking context.

                 right-[10px] (instead of right-0) carves the scrollbar
                 gutter out of the wrapper so native scrollbar clicks at the
                 same y as the composer still land on the scroll container.
                 Without this, the transparent wrapper eats pointer events
                 over the scrollbar area at the bottom of the panel. The
                 10px matches the ::-webkit-scrollbar width in globals.css. */}
            <div className="absolute bottom-0 left-0 right-[10px] px-3 sm:px-4 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              <div className="max-w-3xl mx-auto">
              {/* Approval overlay — sticky above the input form */}
              {pendingApproval && (
                <div className="mb-2">
                  <ApprovalOverlay
                    code={pendingApproval.code}
                    agentLabel={pendingApproval.agentLabel}
                    criticalOps={detectCriticalOperations(pendingApproval.code)}
                    onAllow={() => {
                      pendingApproval.resolve(true);
                      setPendingApproval(null);
                    }}
                    onAllowAll={() => {
                      setAllowAllSession(true);
                      pendingApproval.resolve(true);
                      setPendingApproval(null);
                    }}
                    onReject={() => {
                      pendingApproval.resolve(false);
                      setPendingApproval(null);
                    }}
                  />
                </div>
              )}
              </div>
              <div className="relative mx-auto max-w-3xl">
                {/* Stacked PeekBanners — anchored above the form, flex-col to stack vertically */}
                <div className="absolute bottom-full left-[2px] right-[2px] mb-0 z-0 flex flex-col gap-0">
                  {/* MCP Discovery Warning PeekBanner — amber, shows failed MCP connections */}
                  <PeekBanner
                    open={chatWorkflow.mcpDiscoveryFailures.length > 0}
                    onClose={() => chatWorkflow.clearMCPDiscoveryFailures()}
                    peekHeight={24}
                  >
                    {chatWorkflow.mcpDiscoveryFailures.length > 0 && (
                      <div className="px-4 py-2.5 pr-16 rounded-xl bg-amber-500/10 border border-amber-500/25 backdrop-blur-lg text-xs text-amber-200/90">
                        <div className="font-medium text-amber-300 mb-1.5">
                          ⚠️ {chatWorkflow.mcpDiscoveryFailures.length} MCP {chatWorkflow.mcpDiscoveryFailures.length > 1 ? "services failed" : "service failed"} to connect
                        </div>
                        <ul className="space-y-1">
                          {chatWorkflow.mcpDiscoveryFailures.map((f, i) => (
                            <li key={i} className="text-[11px] leading-relaxed">
                              <span className="font-medium text-amber-200">{f.displayName}</span>
                              <span className="text-amber-400/60 font-mono ml-1.5">({f.label})</span>
                              <div className="text-amber-200/60 font-mono mt-0.5 break-all">{f.error.slice(0, 300)}</div>
                            </li>
                          ))}
                        </ul>
                        <div className="mt-2 text-[10px] text-amber-300/50">
                          These tools are unavailable for this conversation. Try reconnecting from <a href="/account" className="underline hover:text-amber-200">Account page</a>.
                        </div>
                      </div>
                    )}
                  </PeekBanner>

                  {/* Chat Error PeekBanner — red, for fatal chat errors */}
                  <PeekBanner key={errorCount} open={!!chatErrorMsg} onClose={() => setChatErrorMsg(null)} peekHeight={24}>
                    {(() => {
                      if (!chatErrorMsg) return null;
                      let msg = chatErrorMsg;
                      try {
                        const parsed = JSON.parse(msg);
                        if (parsed.error) msg = parsed.error;
                      } catch { /* not JSON */ }
                      const segments = msg.split(/(https?:\/\/[^\s]+|\n)/g);
                      return (
                        <div className="px-4 py-2.5 pr-16 rounded-xl bg-red-500/10 border border-red-500/20 backdrop-blur-lg text-xs text-red-300">
                          <span className="font-medium">Error: </span>
                          {segments.map((seg: string, i: number) =>
                            seg.startsWith("http") ? (
                              <a key={i} href={seg} target="_blank" rel="noopener noreferrer" className="underline text-red-200 hover:text-white break-all">{seg}</a>
                            ) : seg === "\n" ? (
                              <br key={i} />
                            ) : (
                              <span key={i}>{seg}</span>
                            )
                          )}
                        </div>
                      );
                    })()}
                  </PeekBanner>

                </div>
              <ComposerAurora active={isLoading}>
                {/* Phase bubble — inside the aurora wrapper, before the form */}
                <PhaseBubble
                  currentPhase={guardianPhase.currentPhase}
                  history={guardianPhase.history}
                />
              <form
                onSubmit={onSubmit}
                className="composer-aurora-form relative z-10 rounded-2xl border border-white/30 overflow-visible"
                style={{ background: "rgba(10,10,10,0.25)", backdropFilter: "blur(6px) saturate(1.3)", boxShadow: "0 8px 40px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4), 0 1px 0 rgba(255,255,255,0.05) inset" }}
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    e.target.style.height = "auto";
                    const maxH = window.innerHeight * 0.3;
                    e.target.style.height = Math.min(e.target.scrollHeight, maxH) + "px";
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !isLoading) {
                      e.preventDefault();
                      onSubmit(e);
                    }
                  }}
                  placeholder="Ask Guardian to check a component..."
                  className="w-full bg-transparent px-4 pt-3 pb-16 text-sm text-white placeholder:text-white/45 focus:outline-none resize-none overflow-y-auto"
                  rows={3}
                />
                {/* Bottom bar inside the form */}
                <div className="absolute bottom-0 left-0 right-0 flex items-end justify-between gap-2 px-3 py-2">
                  {/* Left: target selectors */}
                  <div className="flex items-end gap-2">
                    <TargetSelector
                      items={designTargets}
                      label="Design"
                      tooltip="Select which design tool receives commands"
                      emptyDescription="All design integrations are disabled. Enable Figma MCP, Plugin, or Console in settings."
                      selected={selectedDesignTarget}
                      onSelect={setSelectedDesignTarget}
                    />
                    <TargetSelector
                      items={codeTargets}
                      label="Code"
                      tooltip="Select which code tool to use"
                      emptyDescription="All code integrations are disabled. Enable Code Editor or GitHub MCP in settings."
                      selected={selectedCodeTarget}
                      onSelect={setSelectedCodeTarget}
                    />
                  </div>
                  {/* Right: model picker + send */}
                  <div className="flex items-end gap-2">
                  {/* Model selector — segmented: Included + My Keys */}
                  <div className="relative">
                    {!modelReady ? (
                      <div className="flex items-center gap-1.5 px-2 py-1">
                        <div className="h-4 w-14 rounded bg-white/10 animate-pulse" />
                        <div className="h-4 w-24 rounded bg-white/[0.06] animate-pulse" />
                      </div>
                    ) : (() => {
                      // Included models (free tier)
                      const FREE_TIER_IDS = ["google/gemini-2.5-flash", "google/gemini-2.5-pro"];
                      const includedModels = gatewayModels.filter((m) => FREE_TIER_IDS.includes(m.id));

                      // BYOK models grouped by key
                      const hasGateway = byokKeys.some((k) => k.provider === "gateway");
                      const directProviders = new Set(byokKeys.filter((k) => k.provider !== "gateway").map((k) => k.provider));
                      const byokModels = hasGateway
                        ? gatewayModels
                        : gatewayModels.filter((m) => directProviders.has(m.owned_by));
                      const byokGrouped = byokModels.reduce<Record<string, GatewayModel[]>>((acc, m) => {
                        (acc[m.owned_by] ??= []).push(m);
                        return acc;
                      }, {});

                      const query = modelSearch.toLowerCase();

                      // Current label
                      const selectedGw = gatewayModels.find((m) => m.id === selectedModel);
                      // Source tag: "Included" or the selected key label
                      const activeKey = selectedSource === "byok" && selectedKeyId
                        ? byokKeys.find((k) => k.id === selectedKeyId) ?? byokKeys.find((k) => k.is_default) ?? byokKeys[0]
                        : selectedSource === "byok"
                          ? byokKeys.find((k) => k.is_default) ?? byokKeys[0]
                          : null;
                      const sourceTag = selectedSource === "included"
                        ? "Included"
                        : activeKey?.label ?? "BYOK";
                      // Find friendly name from gateway or enriched native catalog
                      const nativeKeyModels = activeKey ? nativeModels[activeKey.id] : undefined;
                      const nativeMatch = nativeKeyModels?.find((m) => m.id === selectedModel || `${m.owned_by}/${m.id}` === selectedModel);
                      const displayModel = selectedGw ?? nativeMatch;
                      const selectedLabel = displayModel
                        ? `${displayModel.name}${displayModel.tags?.includes("reasoning") ? " ✦" : ""}`
                        : selectedModel;

                      return (
                        <>
                          <button
                            ref={modelBtnRef}
                            type="button"
                            onClick={() => { setModelDropdownOpen(!modelDropdownOpen); setModelSearch(""); }}
                            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-white/50 hover:text-white/80 hover:bg-white/[0.08] border border-transparent hover:border-white/10 transition-all cursor-pointer max-w-[220px]"
                          >
                            <span className={`shrink-0 text-[9px] px-1 py-0.5 rounded font-medium ${selectedSource === "included" ? "bg-violet-600/30 text-violet-300" : "bg-emerald-600/30 text-emerald-300"}`}>
                              {activeKey?.is_default && <span className="mr-0.5">★</span>}{sourceTag}
                            </span>
                            <span className="truncate">{selectedLabel}</span>
                            <svg
                              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                              className={`shrink-0 transition-transform ${modelDropdownOpen ? "rotate-180" : ""}`}
                            >
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </button>

                          <GlassDropdown open={modelDropdownOpen} onClose={handleModelDropdownClose} anchorRef={modelBtnRef} side="top" align="right" width={280}>
                              <div className="p-2 border-b border-white/[0.06]">
                                <input
                                  type="text"
                                  placeholder="Search models..."
                                  value={modelSearch}
                                  onChange={(e) => setModelSearch(e.target.value)}
                                  autoFocus
                                  className="w-full px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs outline-none focus:border-white/25 transition-colors placeholder:text-white/25"
                                />
                              </div>
                              <div className="max-h-60 overflow-y-auto py-1">
                                {/* ── Included section ── */}
                                <div className="px-3 py-1.5 text-[10px] font-semibold text-violet-400/60 uppercase tracking-wider border-b border-white/[0.04] mb-0.5">
                                  Included (Free tier)
                                </div>
                                {includedModels
                                  .filter((m) => !query || m.name.toLowerCase().includes(query))
                                  .map((m) => (
                                    <button
                                      key={`inc-${m.id}`}
                                      type="button"
                                      onClick={() => {
                                        setSelectedModel(m.id);
                                        setSelectedSource("included");
                                        setSelectedKeyId(null);
                                        setModelDropdownOpen(false);
                                        setModelSearch("");
                                      }}
                                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                                        selectedModel === m.id && selectedSource === "included"
                                          ? "bg-violet-600/30 text-white"
                                          : "text-white/60 hover:bg-white/5 hover:text-white/90"
                                      }`}
                                    >
                                      {m.name}
                                    </button>
                                  ))}
                                {includedModels.filter((m) => !query || m.name.toLowerCase().includes(query)).length === 0 && query && (
                                  <p className="px-3 py-1.5 text-[10px] text-white/20 text-center">No match</p>
                                )}

                                {/* ── My Keys section — grouped by key (label), default first ── */}
                                {byokKeys.length > 0 && (
                                  <>
                                    <div className="px-3 py-1.5 text-[10px] font-semibold text-emerald-400/60 uppercase tracking-wider border-b border-white/[0.04] border-t border-white/[0.04] mt-1 mb-0.5">
                                      My keys
                                    </div>
                                    {[...byokKeys]
                                      .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0))
                                      .map((key) => {
                                      // Use native catalog for direct keys, gateway catalog for gateway keys
                                      const keyModels = key.provider === "gateway"
                                        ? gatewayModels
                                        : nativeModels[key.id] ?? [];
                                      const filtered = keyModels.filter((m) =>
                                        !query || m.name.toLowerCase().includes(query) || (key.label ?? key.provider).toLowerCase().includes(query)
                                      );
                                      if (filtered.length === 0 && query) return null;

                                      const subGrouped = key.provider === "gateway"
                                        ? filtered.reduce<Record<string, typeof filtered>>((acc, m) => {
                                            (acc[m.owned_by] ??= []).push(m);
                                            return acc;
                                          }, {})
                                        : { [key.provider]: filtered };

                                      return (
                                        <div key={key.id} className="mb-1">
                                          {/* Key header */}
                                          <div className="px-3 py-1.5 flex items-center gap-1.5 rounded-md mx-1 bg-white/[0.03]">
                                            {key.is_default
                                              ? <span className="text-emerald-400 text-[11px]">★</span>
                                              : <span className="text-white/15 text-[11px]">☆</span>
                                            }
                                            <span className="text-[11px] font-semibold text-white/60">{key.label ?? `${key.provider}-1`}</span>
                                            {key.key_hint && <span className="text-[9px] text-white/20 font-mono">{key.key_hint}</span>}
                                          </div>
                                          {/* Models tree — indented with left border */}
                                          <div className="ml-[18px] pl-2.5 border-l border-white/[0.06]">
                                            {Object.entries(subGrouped).map(([prov, models]) => (
                                              <div key={`${key.id}-${prov}`}>
                                                {key.provider === "gateway" && (
                                                  <div className="px-1 py-0.5 text-[9px] text-white/25 uppercase tracking-wider mt-0.5">
                                                    {prov.charAt(0).toUpperCase() + prov.slice(1)}
                                                  </div>
                                                )}
                                                {models.map((m) => {
                                                  const isReasoning = "tags" in m && (m as { tags?: string[] }).tags?.includes("reasoning");
                                                  const isKeyDefault = key.default_model === m.id || key.default_model === `${key.provider}/${m.id}`;
                                                  return (
                                                    <button
                                                      key={`byok-${key.id}-${m.id}`}
                                                      type="button"
                                                      onClick={() => {
                                                        // Ensure model ID has provider prefix (native catalogs may not include it)
                                                        const fullId = m.id.includes("/") ? m.id : `${key.provider}/${m.id}`;
                                                        setSelectedModel(fullId);
                                                        setSelectedSource("byok");
                                                        setSelectedKeyId(key.id);
                                                        setModelDropdownOpen(false);
                                                        setModelSearch("");
                                                      }}
                                                      className={`w-full text-left px-2 py-1 text-xs rounded-sm transition-colors cursor-pointer ${
                                                        (selectedModel === m.id || selectedModel === `${key.provider}/${m.id}`) && selectedSource === "byok" && selectedKeyId === key.id
                                                          ? "bg-emerald-600/20 text-white"
                                                          : "text-white/55 hover:bg-white/5 hover:text-white/90"
                                                      }`}
                                                    >
                                                      {isKeyDefault && <span className="text-emerald-400 mr-1">★</span>}
                                                      {m.name}{isReasoning ? <span title="Supports reasoning">{" "}✦</span> : ""}
                                                    </button>
                                                  );
                                                })}
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </>
                                )}

                                {byokKeys.length === 0 && (
                                  <div className="px-3 py-2 border-t border-white/[0.04] mt-1">
                                    <Link
                                      href="/account"
                                      className="text-[10px] text-violet-400 hover:text-violet-300 transition-colors underline underline-offset-2"
                                      onClick={() => setModelDropdownOpen(false)}
                                    >
                                      Add API key for more models
                                    </Link>
                                  </div>
                                )}
                              </div>
                          </GlassDropdown>
                        </>
                      );
                    })()}
                  </div>
                  <GuardianSendButton
                    // During generation the button becomes a dedicated Stop
                    // control — we set type="button" so pressing it doesn't
                    // also submit the form, and wire onClick to cancelMessage
                    // which signals `chatCancel` to the running workflow.
                    type={isLoading ? "button" : "submit"}
                    onClick={isLoading ? cancelMessage : undefined}
                    isGenerating={isLoading}
                    disabled={!isLoading && !input.trim()}
                  />
                  </div>
                </div>
              </form>
              </ComposerAurora>
              </div>{/* end form + peek wrapper */}
            </div>
            </div>{/* end chat panel */}

            {/* ── Right panel: Orchestration conversation ── */}
            <div className="min-w-full h-full relative">
            <div ref={orchScrollContainerRef} onScroll={handleOrchScroll} className={`absolute inset-0 overflow-y-auto px-3 sm:px-4 pb-40 ${headerPaddingClass}`}>
              {/* Unified orchestration view — temporal events; plugin filters to current agent */}
              {temporal.events.length > 0 && (
                orchViewMode === "chat" ? (
                  <OrchestrationChatView
                    events={temporal.events}
                    agents={temporal.agents}
                    agentFilter={isFigmaPlugin ? myDisplayShortId : undefined}
                  />
                ) : (
                  <OrchestrationEventLog
                    events={temporal.events}
                    agents={temporal.agents}
                    agentFilter={isFigmaPlugin ? myDisplayShortId : undefined}
                    showAllEvents={developerMode && devShowAllEvents}
                  />
                )
              )}
              {/* Welcome placeholder when no events yet */}
              {temporal.events.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center px-4">
                  <img src="/guardian-logo.svg" alt="Guardian" className="h-12 mx-auto mb-4" />
                  <h2 className="text-lg font-semibold mb-2">Orchestration</h2>
                  <p className="text-sm text-white/70 max-w-md">
                    Waiting for orchestration events...
                  </p>
                </div>
              )}
              {/* Debug context button in orchestration view */}
              {temporal.events.length > 0 && (
                <CopyDebugButton
                  messages={messages}
                  clients={clients}
                  myClientId={myClientId}
                  myShortId={myDisplayShortId}
                  agentRole={agentRole}
                  orchestration={orchestration}
                  collaborators={collaborators}
                  activeConversationId={activeConversationId}
                  conversations={conversations}
                  model={selectedModel}
                  chatStatus={status}
                  chatError={error}
                  enabledMcps={enabledMcps}
                  mcpReachable={mcpReachable}
                  isFigmaPlugin={isFigmaPlugin}
                  figmaContext={figmaContext}
                  selectedNodeCount={selectedNode?.nodes?.length ?? 0}
                  eventLog={eventLog.current}
                  temporalOrchestration={{
                    workflowId: temporal.workflowId,
                    isActive: temporal.isActive,
                    completedStatus: temporal.completedStatus,
                    agents: temporal.agents,
                    events: temporal.events,
                    connected: temporal.connected,
                    streamError: temporal.streamError,
                    timerRemainingMs: temporal.timerRemainingMs,
                  }}
                  pushTrace={pushTrace}
                  fetchUnifiedDebug={fetchUnifiedDebug}
                />
              )}
            </div>
            {/* ── Orchestration input form (same composer as chat) ── */}
            <div className="absolute bottom-0 left-0 right-0 z-10 px-3 sm:px-4 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              {pendingApproval && (
                <div className="mb-2 max-w-3xl mx-auto">
                  <ApprovalOverlay
                    code={pendingApproval.code}
                    agentLabel={pendingApproval.agentLabel}
                    criticalOps={detectCriticalOperations(pendingApproval.code)}
                    onAllow={() => {
                      pendingApproval.resolve(true);
                      setPendingApproval(null);
                    }}
                    onAllowAll={() => {
                      setAllowAllSession(true);
                      pendingApproval.resolve(true);
                      setPendingApproval(null);
                    }}
                    onReject={() => {
                      pendingApproval.resolve(false);
                      setPendingApproval(null);
                    }}
                  />
                </div>
              )}
              <div className="mx-auto max-w-3xl">
              <ComposerAurora active={temporal.isActive && !orchCompletedStatus}>
                <PhaseBubble
                  currentPhase={orchPhase.currentPhase}
                  history={orchPhase.history}
                />
              <form
                onSubmit={onSubmit}
                className="composer-aurora-form relative z-10 rounded-2xl border border-white/30 overflow-visible"
                style={{ background: "rgba(10,10,10,0.25)", backdropFilter: "blur(6px) saturate(1.3)", boxShadow: "0 8px 40px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4), 0 1px 0 rgba(255,255,255,0.05) inset" }}
              >
                <textarea
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    e.target.style.height = "auto";
                    const maxH = window.innerHeight * 0.3;
                    e.target.style.height = Math.min(e.target.scrollHeight, maxH) + "px";
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !isLoading) {
                      e.preventDefault();
                      onSubmit(e);
                    }
                  }}
                  placeholder="Message the orchestrator..."
                  className={`w-full bg-transparent px-4 pt-3 pb-16 text-sm text-white placeholder:text-white/45 focus:outline-none resize-none overflow-y-auto ${isLoading ? "opacity-50" : ""}`}
                  readOnly={isLoading}
                  rows={3}
                />
                <div className="absolute bottom-0 right-0 flex items-center gap-2 px-3 py-2">
                  <GuardianSendButton
                    type={isLoading ? "button" : "submit"}
                    isGenerating={isLoading}
                    disabled={!isLoading && !input.trim()}
                    onClick={isLoading ? () => cancelMessage?.() : undefined}
                  />
                </div>
              </form>
              </ComposerAurora>
              </div>
            </div>
            </div>{/* end orchestration panel */}

          </div>
        </div>
      </div>

      {proxyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="border border-white/15 rounded-lg p-5 w-full max-w-md mx-4 shadow-2xl" style={{ background: "rgba(10,10,10,0.5)", backdropFilter: "blur(20px) saturate(1.5)", }}>
            <h3 className="text-sm font-semibold text-white mb-1">Configure Proxy</h3>
            <p className="text-xs text-white/50 mb-4">
              Choose between Proxy Online (tunnel) or Proxy Local mode
            </p>

            <div className="space-y-3">
              {/* Section Proxy Online */}
              <div className={`p-3 rounded-md border ${tunnelUrl.trim() ? 'bg-blue-500/10 border-blue-500/30' : 'bg-white/5 border-white/10'}`}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm">🔵</span>
                  <span className={`text-xs font-medium ${tunnelUrl.trim() ? 'text-blue-400' : 'text-white/60'}`}>
                    Proxy Online (Tunnel)
                  </span>
                  {tunnelUrl.trim() && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-blue-500/20 text-blue-300 rounded">Active</span>
                  )}
                </div>
                <label className="block text-xs text-white/60 mb-1">Tunnel URL</label>
                <input
                  type="url"
                  value={tunnelUrl}
                  onChange={(e) => setTunnelUrl(e.target.value)}
                  placeholder="https://your-tunnel.trycloudflare.com"
                  className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
                />
                <p className="text-[10px] text-white/40 mt-1">
                  Will use: {tunnelUrl.trim() ? `${tunnelUrl.replace(/\/$/, '')}/proxy-local/{service}/mcp` : '{tunnel}/proxy-local/{service}/mcp'}
                </p>
              </div>

              {/* Section Proxy Local */}
              <div className={`p-3 rounded-md border ${(localFigmaMcpUrl.trim() || localCodeMcpUrl.trim()) ? 'bg-amber-500/10 border-amber-500/30' : 'bg-white/5 border-white/10'}`}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm">🟢</span>
                  <span className={`text-xs font-medium ${(localFigmaMcpUrl.trim() || localCodeMcpUrl.trim()) ? 'text-amber-400' : 'text-white/60'}`}>
                    Proxy Local
                  </span>
                  {(localFigmaMcpUrl.trim() || localCodeMcpUrl.trim()) && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/20 text-amber-300 rounded">Active</span>
                  )}
                </div>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-white/60 mb-1">Local Figma MCP URL</label>
                    <input
                      type="url"
                      value={localFigmaMcpUrl}
                      onChange={(e) => setLocalFigmaMcpUrl(e.target.value)}
                      placeholder={process.env.NEXT_PUBLIC_LOCAL_MCP_FIGMA_URL || ""}
                      className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-white/60 mb-1">Local Code MCP URL</label>
                    <input
                      type="url"
                      value={localCodeMcpUrl}
                      onChange={(e) => setLocalCodeMcpUrl(e.target.value)}
                      placeholder={process.env.NEXT_PUBLIC_LOCAL_MCP_CODE_URL || ""}
                      className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-white/40 mt-2">
                  Will use: {process.env.NEXT_PUBLIC_PROXY_LOCAL_FIGMA_MCP?.replace('/figma/mcp', '/{service}/mcp') || 'http://localhost:3000/proxy-local/{service}/mcp'}
                </p>
              </div>

              <div>
                <label className="block text-xs text-white/60 mb-1">Secret</label>
                <input
                  type="password"
                  value={tunnelSecret}
                  onChange={(e) => setTunnelSecret(e.target.value)}
                  placeholder="your-secret-key"
                  className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setProxyModalOpen(false)}
                className="flex-1 px-4 py-2 text-sm text-white/60 hover:text-white hover:bg-white/5 rounded-md transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (tunnelUrl.trim()) {
                    const baseUrl = tunnelUrl.trim().replace(/\/$/, '');
                    setFigmaMcpUrl(`${baseUrl}/proxy-local/figma/mcp`);
                    setCodeProjectPath(`${baseUrl}/proxy-local/code/mcp`);
                    // Keep local URLs to send X-MCP-*-URL headers
                    // The server will use these headers to forward to the correct URLs
                  } else {
                    if (localFigmaMcpUrl.trim()) {
                      setFigmaMcpUrl(process.env.NEXT_PUBLIC_PROXY_LOCAL_FIGMA_MCP);
                    }
                    if (localCodeMcpUrl.trim()) {
                      setCodeProjectPath(process.env.NEXT_PUBLIC_PROXY_LOCAL_CODE_MCP);
                    }
                  }
                  setProxyModalOpen(false);
                }}
                className="flex-1 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}