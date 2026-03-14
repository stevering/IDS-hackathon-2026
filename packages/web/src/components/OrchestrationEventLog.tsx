"use client";

import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OrchestrationSSEEvent, AgentViewState } from "@guardian/orchestrations";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  events: OrchestrationSSEEvent[];
  agents: AgentViewState[];
};

// ---------------------------------------------------------------------------
// Event type filter — skip noise events
// ---------------------------------------------------------------------------

const HIDDEN_EVENT_TYPES = new Set(["timer_tick", "connected"]);

function isVisibleEvent(e: OrchestrationSSEEvent): boolean {
  return !HIDDEN_EVENT_TYPES.has(e.type);
}

// ---------------------------------------------------------------------------
// Collapsible thinking block (amber, matches ThinkingBlock style)
// ---------------------------------------------------------------------------

function OrchestratorThinking({ content }: { content: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="my-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-md transition-colors w-full text-left overflow-hidden min-w-0 cursor-pointer bg-amber-500/10 border border-amber-500/20 text-amber-300 hover:bg-amber-500/15"
      >
        <svg
          className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
        </svg>
        <span className="font-medium shrink-0">Orchestrator thinking</span>
        {!open && (
          <span className="truncate opacity-60 min-w-0">
            {content.slice(0, 80)}
            {content.length > 80 ? "..." : ""}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 ml-5 px-3 py-2 rounded text-xs leading-relaxed border-l-2 border-amber-500/30 text-amber-200/70 whitespace-pre-wrap">
          {content}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual event renderers
// ---------------------------------------------------------------------------

function renderEvent(event: OrchestrationSSEEvent, index: number, agents: AgentViewState[]) {
  switch (event.type) {
    // ── Orchestration started ──────────────────────────────────────────
    case "orchestration_started": {
      const agentLabels = event.agents.map(
        (a) => `${a.shortId}${a.fileName ? ` (${a.fileName})` : ""}`
      );
      return (
        <div key={index} className="flex justify-center my-2">
          <div className="px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/15 text-[11px] text-emerald-400/70 max-w-[90%] text-center">
            <span className="font-medium">Orchestration started</span>
            {agentLabels.length > 0 && (
              <span className="text-emerald-400/50 ml-1.5">
                with {agentLabels.join(", ")}
              </span>
            )}
          </div>
        </div>
      );
    }

    // ── Orchestrator thinking ──────────────────────────────────────────
    case "orchestrator_thinking":
      return (
        <div key={index} className="mx-2 sm:mx-4">
          <OrchestratorThinking content={event.content} />
        </div>
      );

    // ── Orchestrator directive ─────────────────────────────────────────
    case "orchestrator_directive": {
      const targetAgent = agents.find((a) => a.shortId === event.agentShortId);
      return (
        <div key={index} className="mx-2 sm:mx-4 my-1.5">
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="shrink-0 text-amber-400/70"
              >
                <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M3 4l17 17" />
              </svg>
              <span className="text-[10px] font-medium text-amber-400/70 uppercase tracking-wider">
                Directive
              </span>
              <span className="text-[10px] text-amber-300/60">
                &rarr; {event.agentShortId}
                {targetAgent?.fileName ? ` (${targetAgent.fileName})` : ""}
              </span>
            </div>
            <div className="text-xs text-amber-200/60 leading-relaxed prose prose-invert prose-xs max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {event.content}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      );
    }

    // ── Agent status changed ──────────────────────────────────────────
    case "agent_status_changed": {
      const statusColors: Record<string, string> = {
        active: "text-emerald-400/70 bg-emerald-500/10 border-emerald-500/15",
        completed: "text-white/40 bg-white/5 border-white/10",
        failed: "text-red-400/70 bg-red-500/10 border-red-500/15",
        interrupted: "text-orange-400/70 bg-orange-500/10 border-orange-500/15",
        pending: "text-white/30 bg-white/5 border-white/10",
      };
      const colorClass =
        statusColors[event.status] ?? statusColors.pending;
      const statusLabel =
        event.status === "active"
          ? "now active"
          : event.status === "completed"
            ? "completed"
            : event.status === "failed"
              ? "failed"
              : event.status === "interrupted"
                ? "interrupted"
                : event.status;
      return (
        <div key={index} className="flex justify-center my-1">
          <div
            className={`px-2.5 py-0.5 rounded-full text-[10px] border ${colorClass}`}
          >
            <span className="font-medium">{event.agentShortId}</span>{" "}
            {statusLabel}
          </div>
        </div>
      );
    }

    // ── Agent report ──────────────────────────────────────────────────
    case "agent_report": {
      const report = event.report;
      const statusBadge = report?.status
        ? report.status === "completed"
          ? "bg-emerald-500/15 text-emerald-400"
          : report.status === "failed"
            ? "bg-red-500/15 text-red-400"
            : report.status === "needs_input"
              ? "bg-orange-500/15 text-orange-400"
              : "bg-violet-500/15 text-violet-400"
        : null;

      return (
        <div key={index} className="mx-2 sm:mx-4 my-1.5">
          <div className="ml-4 mr-2 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2">
            {/* Header */}
            <div className="flex items-center gap-2 mb-1">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="shrink-0 text-violet-400/70"
              >
                <path d="M12 2a4 4 0 014 4v1h2a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2h2V6a4 4 0 014-4z" />
                <circle cx="9" cy="13" r="1" fill="currentColor" />
                <circle cx="15" cy="13" r="1" fill="currentColor" />
              </svg>
              <span className="text-[10px] font-medium text-violet-400/70">
                Agent {event.agentShortId}
              </span>
              {statusBadge && (
                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wider ${statusBadge}`}
                >
                  {report!.status}
                </span>
              )}
              {report?.timestamp && (
                <span className="text-[10px] text-white/20 ml-auto">
                  {new Date(report.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              )}
            </div>

            {/* Summary */}
            {report?.summary && (
              <div className="text-xs text-white/60 leading-relaxed prose prose-invert prose-xs max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {report.summary}
                </ReactMarkdown>
              </div>
            )}

            {/* Changes list */}
            {report?.changes && report.changes.length > 0 && (
              <details className="mt-1.5">
                <summary className="text-[10px] text-white/30 cursor-pointer hover:text-white/50">
                  {report.changes.length} change{report.changes.length > 1 ? "s" : ""} made
                </summary>
                <ul className="mt-1 space-y-0.5 ml-3">
                  {report.changes.map((c, ci) => (
                    <li
                      key={ci}
                      className="text-[10px] text-white/40 flex items-start gap-1.5"
                    >
                      <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-violet-500/30" />
                      <span>
                        <span className="text-violet-400/50 font-medium">
                          {c.type}
                        </span>{" "}
                        {c.description}
                        {c.nodeName && (
                          <span className="text-white/20 ml-1">
                            ({c.nodeName})
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      );
    }

    // ── Peer message ──────────────────────────────────────────────────
    case "peer_message":
      return (
        <div key={index} className="mx-2 sm:mx-4 my-1.5">
          <div className="ml-4 mr-2 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-medium text-violet-400/70">
                {event.fromAgentId}
              </span>
              <span className="text-[10px] text-white/30">
                &rarr; {event.toAgentId}
              </span>
            </div>
            <div className="text-xs text-white/60 leading-relaxed prose prose-invert prose-xs max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {event.content}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      );

    // ── Broadcast message ─────────────────────────────────────────────
    case "broadcast_message":
      return (
        <div key={index} className="mx-2 sm:mx-4 my-1.5">
          <div className="ml-4 mr-2 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-medium text-violet-400/70">
                {event.fromAgentId}
              </span>
              <span className="text-[10px] text-white/30">broadcast</span>
            </div>
            <div className="text-xs text-white/60 leading-relaxed prose prose-invert prose-xs max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {event.content}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      );

    // ── Sub-conversation opened ───────────────────────────────────────
    case "sub_conv_opened":
      return (
        <div key={index} className="flex justify-center my-1">
          <div className="px-2.5 py-0.5 rounded-full text-[10px] border border-violet-500/15 bg-violet-500/10 text-violet-400/70">
            Sub-conversation: <span className="font-medium">{event.topic}</span>{" "}
            ({event.participantIds.join(", ")})
          </div>
        </div>
      );

    // ── Sub-conversation message ──────────────────────────────────────
    case "sub_conv_message":
      return (
        <div key={index} className="mx-2 sm:mx-4 my-1">
          <div className="ml-8 mr-2 rounded-lg border border-violet-500/15 bg-violet-500/5 px-3 py-1.5">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] font-medium text-violet-400/50">
                {event.fromAgentId}
              </span>
              <span className="text-[9px] text-white/20">sub-conv</span>
            </div>
            <div className="text-xs text-white/50 leading-relaxed prose prose-invert prose-xs max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {event.content}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      );

    // ── Sub-conversation closed ───────────────────────────────────────
    case "sub_conv_closed":
      return (
        <div key={index} className="flex justify-center my-1">
          <div className="px-2.5 py-0.5 rounded-full text-[10px] border border-white/10 bg-white/5 text-white/30">
            Sub-conversation closed ({event.reason})
          </div>
        </div>
      );

    // ── User input received ───────────────────────────────────────────
    case "user_input_received":
      return (
        <div key={index} className="flex justify-center my-1">
          <div className="px-2.5 py-0.5 rounded-full text-[10px] border border-blue-500/15 bg-blue-500/10 text-blue-400/70">
            User input received
            {event.targetAgentId && (
              <span className="ml-1 text-blue-400/50">
                &rarr; {event.targetAgentId}
              </span>
            )}
          </div>
        </div>
      );

    // ── Orchestration completed ───────────────────────────────────────
    case "orchestration_completed": {
      const statusStyles: Record<string, string> = {
        completed:
          "bg-emerald-500/10 border-emerald-500/15 text-emerald-400/70",
        cancelled:
          "bg-amber-500/10 border-amber-500/15 text-amber-400/70",
        timed_out:
          "bg-amber-500/10 border-amber-500/15 text-amber-400/70",
      };
      const style =
        statusStyles[event.status] ?? statusStyles.completed;
      const label =
        event.status === "completed"
          ? "Orchestration completed"
          : event.status === "cancelled"
            ? "Orchestration cancelled"
            : "Orchestration timed out";
      return (
        <div key={index} className="flex justify-center my-2">
          <div
            className={`px-3 py-1.5 rounded-full text-[11px] border font-medium ${style}`}
          >
            {label}
          </div>
        </div>
      );
    }

    // ── Error ─────────────────────────────────────────────────────────
    case "error":
      return (
        <div key={index} className="mx-2 sm:mx-4 my-1.5">
          <div className="px-3 py-2 rounded-lg border border-red-500/25 bg-red-500/10 text-xs text-red-300">
            <span className="font-medium">Error:</span> {event.message}
          </div>
        </div>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * OrchestrationEventLog — renders a live feed of Temporal orchestration
 * events in the chat area. Filters out noise events (timer_tick, connected)
 * and auto-scrolls to the bottom when new events arrive.
 */
export function OrchestrationEventLog({ events, agents }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const visibleEvents = events.filter(isVisibleEvent);

  // Auto-scroll to the latest event
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [visibleEvents.length]);

  if (visibleEvents.length === 0) return null;

  return (
    <div className="mt-2 mb-4">
      {/* Section label */}
      <div className="flex items-center gap-2 mx-4 mb-2">
        <div className="h-px flex-1 bg-amber-500/15" />
        <span className="text-[10px] text-amber-400/50 font-medium uppercase tracking-wider shrink-0">
          Orchestration
        </span>
        <div className="h-px flex-1 bg-amber-500/15" />
      </div>

      {/* Event list */}
      {visibleEvents.map((event, i) => renderEvent(event, i, agents))}

      {/* Scroll anchor */}
      <div ref={endRef} />
    </div>
  );
}
