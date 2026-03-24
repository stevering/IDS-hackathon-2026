"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OrchestrationSSEEvent, AgentViewState, AgentActivity } from "@guardian/orchestrations";
import { getEventMeta, getActivityMeta, formatDirection, CATEGORY_COLORS } from "@guardian/orchestrations/event-meta";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  events: OrchestrationSSEEvent[];
  agents: AgentViewState[];
  agentFilter?: string;
  showAllEvents?: boolean;
};

// ---------------------------------------------------------------------------
// Event visibility (metadata-driven)
// ---------------------------------------------------------------------------

function isVisibleEvent(e: OrchestrationSSEEvent, showAllEvents?: boolean): boolean {
  if (showAllEvents) return true;
  return getEventMeta(e).visibleInNormalMode;
}

function matchesAgentFilter(e: OrchestrationSSEEvent, agentFilter: string): boolean {
  switch (e.type) {
    case "orchestration_started":
    case "orchestration_completed":
    case "error":
      return true;
    case "orchestrator_directive":
    case "agent_status_changed":
    case "agent_report":
    case "guardrail_blocked":
    case "agent_activity":
      return e.agentShortId === agentFilter;
    case "user_input_received":
      return !e.targetAgentId || e.targetAgentId === agentFilter;
    case "peer_message":
      return e.fromAgentId === agentFilter || e.toAgentId === agentFilter;
    case "broadcast_message":
      return e.fromAgentId === agentFilter;
    case "sub_conv_opened":
      return e.participantIds.includes(agentFilter);
    case "sub_conv_message":
      return e.fromAgentId === agentFilter;
    case "orchestrator_brief":
    case "orchestrator_text": case "orchestrator_reasoning":
    case "orchestrator_tool_call":
    case "orchestrator_tool_result":
    case "orchestrator_input":
    case "guardian_feedback":
    case "system_prompt":
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Unified EventBlock — collapsible block with metadata header
// ---------------------------------------------------------------------------

function EventBlock({
  event,
  agents,
  title,
  subject,
  preview,
  defaultOpen = false,
  colorClass,
  children,
}: {
  event: OrchestrationSSEEvent;
  agents: AgentViewState[];
  title: string;
  subject?: string;
  preview?: string;
  defaultOpen?: boolean;
  colorClass: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = getEventMeta(event);
  const catColor = CATEGORY_COLORS[meta.category];
  const dir = formatDirection(meta, event, agents, false);

  return (
    <div className={`mx-2 sm:mx-4 my-1 rounded-lg border ${colorClass} overflow-hidden`}
      style={{ background: "rgba(10, 10, 10, 0.35)", backdropFilter: "blur(24px) saturate(1.4)" }}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full text-left px-2.5 py-1.5 cursor-pointer hover:bg-white/[0.02] transition-colors min-w-0"
      >
        <svg
          className={`h-2.5 w-2.5 shrink-0 transition-transform opacity-40 ${open ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
        </svg>
        <span className={`text-[7px] px-1 py-px rounded border font-medium uppercase tracking-wider shrink-0 ${catColor}`}>
          {meta.category}
        </span>
        <span className="text-[8px] text-white/25 font-mono shrink-0">{dir}</span>
        <span className="text-[10px] font-medium opacity-80 shrink-0">{title}</span>
        {subject && (
          <span className="text-[10px] opacity-50 shrink-0">{subject}</span>
        )}
        {!open && preview && (
          <span className="text-[10px] opacity-40 truncate min-w-0">
            {preview.slice(0, 80)}{preview.length > 80 ? "..." : ""}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-2 pt-0.5">
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle pill (for started, completed, status_changed)
// ---------------------------------------------------------------------------

function LifecyclePill({
  event,
  agents,
  label,
  detail,
  colorClass,
}: {
  event: OrchestrationSSEEvent;
  agents: AgentViewState[];
  label: string;
  detail?: string;
  colorClass: string;
}) {
  const meta = getEventMeta(event);
  const catColor = CATEGORY_COLORS[meta.category];

  return (
    <div className="flex justify-center my-1.5">
      <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] border ${colorClass}`}
        style={{ background: "rgba(10, 10, 10, 0.35)", backdropFilter: "blur(24px) saturate(1.4)" }}>
        <span className={`text-[7px] px-1 py-px rounded border font-medium uppercase tracking-wider ${catColor}`}>
          {meta.category}
        </span>
        <span className="font-medium">{label}</span>
        {detail && <span className="opacity-60">{detail}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Render individual events
// ---------------------------------------------------------------------------

function renderEvent(event: OrchestrationSSEEvent, index: number, agents: AgentViewState[], showAllEvents?: boolean) {
  switch (event.type) {
    // ── Orchestration started ──────────────────────────────────────────
    case "orchestration_started": {
      const agentLabels = event.agents
        .map((a) => `${a.shortId}${a.fileName ? ` (${a.fileName})` : ""}`)
        .join(", ");
      return (
        <div key={index}>
          <LifecyclePill
            event={event}
            agents={agents}
            label="Orchestration started"
            detail={`with ${agentLabels}`}
            colorClass="bg-emerald-500/10 border-emerald-500/15 text-emerald-400/70"
          />
        </div>
      );
    }

    // ── Orchestrator brief ─────────────────────────────────────────────
    case "orchestrator_brief":
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Briefing"
            preview={event.content.split("\n")[0]}
            defaultOpen={false}
            colorClass="border-sky-500/20 bg-sky-500/5 text-sky-300"
          >
            <div className="text-xs text-sky-200/50 leading-relaxed prose prose-invert prose-xs max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
            </div>
          </EventBlock>
        </div>
      );

    // ── Orchestrator tool call ─────────────────────────────────────────
    case "orchestrator_tool_call": {
      const argsSummary = Object.entries(event.args)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ");
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Tool call"
            subject={event.toolName}
            preview={argsSummary}
            defaultOpen={false}
            colorClass="border-indigo-500/15 bg-indigo-500/5 text-indigo-300"
          >
            <pre className="text-[10px] text-indigo-200/50 whitespace-pre-wrap font-mono">
              {JSON.stringify(event.args, null, 2)}
            </pre>
          </EventBlock>
        </div>
      );
    }

    // ── Orchestrator tool result ───────────────────────────────────────
    case "orchestrator_tool_result": {
      const isError = (event as { isError?: boolean }).isError;
      const result = (event as { result?: string }).result ?? "";
      const toolName = (event as { toolName?: string }).toolName ?? "";
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title={isError ? "Tool error" : "Tool result"}
            subject={toolName}
            preview={result}
            defaultOpen={false}
            colorClass={isError
              ? "border-red-500/15 bg-red-500/5 text-red-300"
              : "border-violet-500/15 bg-violet-500/5 text-violet-300"
            }
          >
            <div className="text-[10px] opacity-70 whitespace-pre-wrap">{result}</div>
          </EventBlock>
        </div>
      );
    }

    // ── Orchestrator text / reasoning ───────────────────────────────────
    case "orchestrator_text": case "orchestrator_reasoning": {
      const isReasoning = event.type === "orchestrator_reasoning";
      const simLabel = isReasoning && "simulated" in event && event.simulated ? " (simulated)" : "";
      const modelLabel = event.modelId ? ` [${event.modelId}]` : "";
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Orchestrator"
            subject={event.usage ? `${isReasoning ? "reasoning" : "response"}${simLabel}${modelLabel}  ${event.usage.totalTokens} tok` : `${isReasoning ? "reasoning" : "response"}${simLabel}${modelLabel}`}
            preview={event.content}
            defaultOpen={true}
            colorClass="border-amber-500/20 bg-amber-500/5 text-amber-300"
          >
            <div className="text-xs text-amber-200/70 leading-relaxed whitespace-pre-wrap">
              {event.content}
            </div>
            {(event.usage || event.modelId) && (
              <div className="mt-1 text-[8px] font-mono text-amber-300/40 border-t border-amber-500/10 pt-1">
                {event.modelId && <span>{event.modelId}</span>}
                {event.usage && <span>{event.modelId ? " · " : ""}{event.usage.totalTokens} tokens ({event.usage.promptTokens} in + {event.usage.completionTokens} out)</span>}
              </div>
            )}
          </EventBlock>
        </div>
      );
    }

    // ── System prompt ────────────────────────────────────────────────
    case "system_prompt": {
      const spTarget = event.targetRole === "agent" && event.targetAgentShortId
        ? event.targetAgentShortId
        : event.targetRole;
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="System Prompt"
            subject={`→ ${spTarget}`}
            preview={event.content.slice(0, 80)}
            defaultOpen={false}
            colorClass="border-white/10 bg-white/5 text-white/50"
          >
            <div className="text-[9px] text-white/40 leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
              {event.content}
            </div>
          </EventBlock>
        </div>
      );
    }

    // ── Guardian feedback ──────────────────────────────────────────────
    case "guardian_feedback": {
      const fbTarget = event.targetRole === "agent" && event.targetAgentShortId
        ? `→ ${event.targetAgentShortId}`
        : `→ ${event.targetRole}`;
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Guardian"
            subject={`feedback ${fbTarget}`}
            preview={event.content}
            defaultOpen={false}
            colorClass="border-orange-500/20 bg-orange-500/5 text-orange-300"
          >
            <div className="text-xs text-orange-200/70 leading-relaxed whitespace-pre-wrap">
              {event.content}
            </div>
          </EventBlock>
        </div>
      );
    }

    // ── Orchestrator directive ──────────────────────────────────────────
    case "orchestrator_directive": {
      const targetAgent = agents.find((a) => a.shortId === event.agentShortId);
      const targetLabel = `→ ${event.agentShortId}${targetAgent?.fileName ? ` (${targetAgent.fileName})` : ""}`;
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Directive"
            subject={targetLabel}
            preview={event.content}
            defaultOpen={true}
            colorClass="border-amber-500/25 bg-amber-500/10 text-amber-300"
          >
            <div className="text-xs text-amber-200/60 leading-relaxed prose prose-invert prose-xs max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
            </div>
          </EventBlock>
        </div>
      );
    }

    // ── Agent status changed ───────────────────────────────────────────
    case "agent_status_changed": {
      const statusColors: Record<string, string> = {
        active: "text-emerald-400/70 bg-emerald-500/10 border-emerald-500/15",
        completed: "text-white/40 bg-white/5 border-white/10",
        failed: "text-red-400/70 bg-red-500/10 border-red-500/15",
        interrupted: "text-orange-400/70 bg-orange-500/10 border-orange-500/15",
        pending: "text-white/30 bg-white/5 border-white/10",
      };
      const colorClass = statusColors[event.status] ?? statusColors.pending;
      return (
        <div key={index}>
          <LifecyclePill
            event={event}
            agents={agents}
            label={event.agentShortId}
            detail={event.status}
            colorClass={colorClass}
          />
        </div>
      );
    }

    // ── Guardrail blocked ──────────────────────────────────────────────
    case "guardrail_blocked":
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Guardrail"
            subject={event.agentShortId}
            preview={`${event.blockedAction} — ${event.reason}`}
            defaultOpen={true}
            colorClass="border-red-500/30 bg-red-500/10 text-red-300"
          >
            <div className="text-xs text-red-200/70 leading-relaxed">
              <span className="font-medium text-red-300/80">{event.blockedAction}</span>
              {" — "}
              {event.reason}
            </div>
          </EventBlock>
        </div>
      );

    // ── Agent report ───────────────────────────────────────────────────
    case "agent_report": {
      const report = event.report;
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Report"
            subject={`${event.agentShortId} · ${report?.status ?? "unknown"}`}
            preview={report?.summary}
            defaultOpen={true}
            colorClass="border-violet-500/20 bg-violet-500/5 text-violet-300"
          >
            {report?.summary && (
              <div className="text-xs text-white/60 leading-relaxed prose prose-invert prose-xs max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.summary}</ReactMarkdown>
              </div>
            )}
            {report?.changes && report.changes.length > 0 && (
              <details className="mt-1.5">
                <summary className="text-[10px] text-white/30 cursor-pointer hover:text-white/50">
                  {report.changes.length} change{report.changes.length > 1 ? "s" : ""}
                </summary>
                <ul className="mt-1 space-y-0.5 ml-3">
                  {report.changes.map((c, ci) => (
                    <li key={ci} className="text-[10px] text-white/40 flex items-start gap-1.5">
                      <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-violet-500/30" />
                      <span>
                        <span className="text-violet-400/50 font-medium">{c.type}</span> {c.description}
                        {c.nodeName && <span className="text-white/20 ml-1">({c.nodeName})</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </EventBlock>
        </div>
      );
    }

    // ── Peer message ───────────────────────────────────────────────────
    case "peer_message":
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Peer msg"
            subject={`${event.fromAgentId} → ${event.toAgentId}`}
            preview={event.content}
            defaultOpen={true}
            colorClass="border-violet-500/20 bg-violet-500/5 text-violet-300"
          >
            <div className="text-xs text-white/60 leading-relaxed prose prose-invert prose-xs max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
            </div>
          </EventBlock>
        </div>
      );

    // ── Broadcast message ──────────────────────────────────────────────
    case "broadcast_message":
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Broadcast"
            subject={event.fromAgentId}
            preview={event.content}
            defaultOpen={true}
            colorClass="border-violet-500/20 bg-violet-500/5 text-violet-300"
          >
            <div className="text-xs text-white/60 leading-relaxed prose prose-invert prose-xs max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
            </div>
          </EventBlock>
        </div>
      );

    // ── Sub-conversation opened ────────────────────────────────────────
    case "sub_conv_opened":
      return (
        <div key={index}>
          <LifecyclePill
            event={event}
            agents={agents}
            label="Sub-conv"
            detail={`${event.topic} (${event.participantIds.join(", ")})`}
            colorClass="bg-violet-500/10 border-violet-500/15 text-violet-400/70"
          />
        </div>
      );

    // ── Sub-conversation message ───────────────────────────────────────
    case "sub_conv_message":
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Sub-conv msg"
            subject={event.fromAgentId}
            preview={event.content}
            defaultOpen={true}
            colorClass="border-violet-500/15 bg-violet-500/5 text-violet-300"
          >
            <div className="text-xs text-white/50 leading-relaxed prose prose-invert prose-xs max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
            </div>
          </EventBlock>
        </div>
      );

    // ── Sub-conversation closed ────────────────────────────────────────
    case "sub_conv_closed":
      return (
        <div key={index}>
          <LifecyclePill
            event={event}
            agents={agents}
            label="Sub-conv closed"
            detail={event.reason}
            colorClass="bg-white/5 border-white/10 text-white/30"
          />
        </div>
      );

    // ── User input received ────────────────────────────────────────────
    case "user_input_received":
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="User"
            subject={event.targetAgentId ? `→ ${event.targetAgentId}` : undefined}
            preview={event.content}
            defaultOpen={true}
            colorClass="border-blue-500/25 bg-blue-500/10 text-blue-300"
          >
            <div className="text-xs text-blue-200/80 leading-relaxed">
              {event.content}
            </div>
          </EventBlock>
        </div>
      );

    // ── Orchestration completed ────────────────────────────────────────
    case "orchestration_completed":
      return (
        <div key={index}>
          <LifecyclePill
            event={event}
            agents={agents}
            label={
              event.status === "completed" ? "Orchestration completed"
                : event.status === "completed_with_errors" ? "Orchestration completed with errors"
                  : event.status === "failed" ? "Orchestration failed"
                    : event.status === "cancelled" ? "Orchestration cancelled"
                      : "Orchestration timed out"
            }
            colorClass={
              event.status === "completed"
                ? "bg-emerald-500/10 border-emerald-500/15 text-emerald-400/70"
                : event.status === "failed" || event.status === "completed_with_errors"
                  ? "bg-red-500/10 border-red-500/15 text-red-400/70"
                  : "bg-amber-500/10 border-amber-500/15 text-amber-400/70"
            }
          />
        </div>
      );

    // ── Error ──────────────────────────────────────────────────────────
    case "error":
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Error"
            preview={event.message}
            defaultOpen={true}
            colorClass="border-red-500/25 bg-red-500/10 text-red-300"
          >
            <div className="text-xs text-red-300">{event.message}</div>
          </EventBlock>
        </div>
      );

    // ── Agent activity ─────────────────────────────────────────────────
    case "agent_activity":
      return (
        <div key={index} className="mx-2 sm:mx-4 my-0.5">
          <div className="ml-4 mr-2 space-y-0.5">
            {event.activities.map((act, ai) => (
              <AgentActivityItem key={ai} activity={act} agentShortId={event.agentShortId} />
            ))}
          </div>
        </div>
      );

    // ── Orchestrator input ─────────────────────────────────────────────
    case "orchestrator_input":
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title="Input"
            subject={event.fromAgentShortId ? `from ${event.fromAgentShortId}` : undefined}
            preview={event.content}
            defaultOpen={false}
            colorClass="border-white/8 bg-white/[0.02] text-white/40"
          >
            <div className="text-[10px] text-white/40 leading-relaxed whitespace-pre-wrap">
              {event.content}
            </div>
          </EventBlock>
        </div>
      );

    default:
      if (!showAllEvents) return null;
      return (
        <div key={index}>
          <EventBlock
            event={event}
            agents={agents}
            title={event.type}
            preview={JSON.stringify(event).slice(0, 100)}
            defaultOpen={false}
            colorClass="border-white/5 bg-white/[0.01] text-white/30"
          >
            <pre className="text-[9px] text-white/20 font-mono whitespace-pre-wrap">
              {JSON.stringify(event, null, 2)}
            </pre>
          </EventBlock>
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Agent activity item (with category pill)
// ---------------------------------------------------------------------------

function AgentActivityItem({ activity, agentShortId }: { activity: AgentActivity; agentShortId: string }) {
  const meta = getActivityMeta(activity);
  const catColor = CATEGORY_COLORS[meta.category];

  const pill = (
    <span className={`text-[7px] px-1 py-px rounded border font-medium uppercase tracking-wider ${catColor}`}>
      {meta.category}
    </span>
  );

  switch (activity.action) {
    case "reasoning":
      return (
        <ActivityRow pill={pill} label={`${agentShortId} reasoning${activity.simulated ? " (simulated)" : ""}${activity.modelId ? ` [${activity.modelId}]` : ""}`} detail={activity.content}
          usage={activity.usage}
          colorClass="bg-amber-500/5 border-amber-500/10 text-amber-400/60 hover:bg-amber-500/10" />
      );
    case "assistant_text":
      return (
        <ActivityRow pill={pill} label={`${agentShortId} response${activity.modelId ? ` [${activity.modelId}]` : ""}`} detail={activity.content}
          usage={activity.usage}
          colorClass="bg-cyan-500/5 border-cyan-500/10 text-cyan-400/60 hover:bg-cyan-500/10" />
      );
    case "tool_call":
      return (
        <ActivityRow pill={pill} label={`${agentShortId} ${activity.toolName}`} detail={activity.summary}
          usage={activity.usage}
          colorClass="bg-indigo-500/5 border-indigo-500/10 text-indigo-400/60 hover:bg-indigo-500/10" />
      );
    case "code_review_passed":
      return (
        <ActivityRow pill={pill} label={`${agentShortId} Linter OK`} detail={activity.codeSnippet}
          colorClass="bg-emerald-500/5 border-emerald-500/10 text-emerald-400/60 hover:bg-emerald-500/10" />
      );
    case "code_review_llm_approved":
      return (
        <ActivityRow pill={pill} label={`${agentShortId} Review OK`} detail={activity.codeSnippet}
          colorClass="bg-emerald-500/5 border-emerald-500/10 text-emerald-400/60 hover:bg-emerald-500/10" />
      );
    case "code_review_rejected":
      return (
        <ActivityRow pill={pill} label={`${agentShortId} Linter rejected`} detail={activity.issues.join("\n")}
          colorClass="bg-red-500/10 border-red-500/15 text-red-400/70 hover:bg-red-500/15" />
      );
    case "code_review_llm_rejected":
      return (
        <ActivityRow pill={pill} label={`${agentShortId} Review rejected`} detail={`${activity.issues}\n\n${activity.codeSnippet}`}
          colorClass="bg-red-500/10 border-red-500/15 text-red-400/70 hover:bg-red-500/15" />
      );
    case "code_executed":
      return (
        <ActivityRow pill={pill} label={`${agentShortId} ${activity.success ? "Executed" : "Failed"}`} detail={activity.summary}
          colorClass={activity.success
            ? "bg-emerald-500/5 border-emerald-500/10 text-emerald-400/60 hover:bg-emerald-500/10"
            : "bg-red-500/5 border-red-500/10 text-red-400/60 hover:bg-red-500/10"} />
      );
    case "external_tool_result": {
      // Extract tool name from summary (format: "toolName: OK — result" or "toolName: FAILED — error")
      const toolMatch = activity.summary.match(/^([^:]+):\s*(OK|FAILED)/);
      const toolName = toolMatch?.[1] ?? "MCP Tool";
      // Detect MCP errors hidden inside success responses
      const hasHiddenError = activity.success && activity.summary.includes("MCP error");
      const effectiveSuccess = activity.success && !hasHiddenError;
      const statusLabel = hasHiddenError ? "Error" : effectiveSuccess ? "OK" : "Failed";
      const detail = toolMatch ? activity.summary.slice(toolMatch[0].length).replace(/^\s*—\s*/, "") : activity.summary;
      return (
        <ActivityRow pill={pill} label={`${agentShortId} ${toolName} ${statusLabel}`} detail={detail}
          colorClass={effectiveSuccess
            ? "bg-blue-500/5 border-blue-500/10 text-blue-400/60 hover:bg-blue-500/10"
            : "bg-red-500/5 border-red-500/10 text-red-400/60 hover:bg-red-500/10"} />
      );
    }
    case "code_verified": {
      let formatted: string;
      try {
        const parsed = JSON.parse(activity.selection);
        const lines: string[] = [];
        if (parsed.added?.length > 0) {
          for (const n of parsed.added as Array<Record<string, unknown>>) {
            let line = `+ ${n.type} "${n.name}" ${n.width}x${n.height} @(${n.x},${n.y})`;
            if (Array.isArray(n.fills) && n.fills.length > 0) {
              const c = (n.fills[0] as Record<string, Record<string, number>>).color;
              if (c) line += ` fill: rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
            }
            lines.push(line);
          }
        }
        if (parsed.removedCount > 0) lines.push(`- ${parsed.removedCount} node(s) removed`);
        if (parsed.added?.length === 0 && parsed.removedCount === 0) lines.push("No changes detected");
        lines.push(`Total: ${parsed.totalChildren} children on page`);
        formatted = lines.join("\n");
      } catch {
        formatted = activity.selection;
      }
      return (
        <ActivityRow pill={pill} label={`${agentShortId} Verified`} detail={formatted}
          colorClass="bg-teal-500/5 border-teal-500/10 text-teal-400/60 hover:bg-teal-500/10" />
      );
    }
    case "file_review_llm_response": {
      let diffFormatted = activity.diff;
      try {
        const d = JSON.parse(activity.diff);
        const lines: string[] = [];
        if (d.added?.length > 0) {
          for (const n of d.added as Array<Record<string, unknown>>) {
            let line = `+ ${n.type} "${n.name}" ${n.width}x${n.height} @(${n.x},${n.y})`;
            if (Array.isArray(n.fills) && n.fills.length > 0) {
              const c = (n.fills[0] as Record<string, Record<string, number>>).color;
              if (c) line += ` fill:rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
            }
            lines.push(line);
          }
        }
        if (d.removedCount > 0) lines.push(`- ${d.removedCount} node(s) removed`);
        lines.push(`Total: ${d.totalChildren} children on page`);
        diffFormatted = lines.join("\n");
      } catch { /* keep raw */ }

      return (
        <FileReviewRow
          pill={pill}
          agentShortId={agentShortId}
          activity={activity}
          diffFormatted={diffFormatted}
        />
      );
    }
    case "guardian_message":
      return (
        <ActivityRow pill={pill} label={`Guardian → ${activity.recipient}`} detail={activity.message}
          colorClass="bg-white/[0.02] border-white/8 text-white/40 hover:bg-white/[0.04]" />
      );
    case "code_review_llm_response":
      return (
        <ActivityRow pill={pill} label={`${agentShortId} Review response`}
          detail={`${activity.response}${activity.reasoning ? `\n\nReasoning: ${activity.reasoning}` : ""}`}
          usage={activity.usage}
          colorClass="bg-violet-500/5 border-violet-500/10 text-violet-400/60 hover:bg-violet-500/10" />
      );
    default:
      return null;
  }
}

function FileReviewRow({
  pill,
  agentShortId,
  activity,
  diffFormatted,
}: {
  pill: React.ReactNode;
  agentShortId: string;
  activity: Extract<import("@guardian/orchestrations").AgentActivity, { action: "file_review_llm_response" }>;
  diffFormatted: string;
}) {
  const [open, setOpen] = useState(false);
  const isOk = activity.status === "verified";
  const colorClass = isOk
    ? "bg-teal-500/5 border-teal-500/10 text-teal-400/60 hover:bg-teal-500/10"
    : "bg-orange-500/5 border-orange-500/10 text-orange-400/60 hover:bg-orange-500/10";

  return (
    <div className={`rounded border ${colorClass}`}
      style={{ background: "rgba(10, 10, 10, 0.35)", backdropFilter: "blur(24px) saturate(1.4)" }}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10px] px-2 py-0.5 w-full text-left cursor-pointer hover:bg-white/[0.02] transition-colors min-w-0"
      >
        <svg className={`h-2.5 w-2.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
        </svg>
        {pill}
        <span className="font-mono font-medium shrink-0">{agentShortId} File review: {isOk ? "OK" : "ISSUE"}</span>
        {activity.usage && <span className="shrink-0 text-[8px] font-mono opacity-50">{activity.usage.totalTokens} tok</span>}
        {!open && <span className="truncate opacity-60 min-w-0">{activity.verdict.slice(0, 80)}</span>}
      </button>
      {open && (
        <div className="px-2 pb-2 pt-1 text-[10px] border-t border-inherit space-y-2">
          <div>
            <div className="font-medium opacity-70 mb-0.5">{isOk ? "VERIFIED" : "ISSUE"}</div>
            <div className="opacity-80">{activity.verdict}</div>
          </div>

          {(activity.beforeScreenshot || activity.afterScreenshot) && (
            <div>
              <div className="font-medium opacity-70 mb-1">Screenshots</div>
              <div className="flex gap-2 overflow-x-auto">
                {activity.beforeScreenshot && (
                  <div className="shrink-0">
                    <div className="text-[8px] opacity-50 mb-0.5">Before</div>
                    <img src={`data:image/png;base64,${activity.beforeScreenshot}`} alt="Before" className="max-h-32 rounded border border-white/10" />
                  </div>
                )}
                {activity.afterScreenshot && (
                  <div className="shrink-0">
                    <div className="text-[8px] opacity-50 mb-0.5">After</div>
                    <img src={`data:image/png;base64,${activity.afterScreenshot}`} alt="After" className="max-h-32 rounded border border-white/10" />
                  </div>
                )}
              </div>
            </div>
          )}

          <div>
            <div className="font-medium opacity-70 mb-0.5">Code executed</div>
            <pre className="text-[9px] opacity-60 whitespace-pre-wrap break-all bg-black/20 rounded p-1">{activity.code}</pre>
          </div>

          <div>
            <div className="font-medium opacity-70 mb-0.5">Figma diff</div>
            <pre className="text-[9px] opacity-60 whitespace-pre-wrap break-all bg-black/20 rounded p-1">{diffFormatted}</pre>
          </div>

          <div>
            <div className="font-medium opacity-70 mb-0.5">Raw LLM response</div>
            <pre className="text-[9px] opacity-60 whitespace-pre-wrap break-all bg-black/20 rounded p-1">{activity.rawResponse}</pre>
          </div>

          {activity.usage && (
            <div className="text-[8px] font-mono opacity-40 border-t border-inherit pt-1">
              {activity.usage.totalTokens} tokens ({activity.usage.promptTokens} in + {activity.usage.completionTokens} out)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityRow({
  pill,
  label,
  detail,
  usage,
  colorClass,
}: {
  pill: React.ReactNode;
  label: string;
  detail: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  colorClass: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded border ${colorClass}`}
      style={{ background: "rgba(10, 10, 10, 0.35)", backdropFilter: "blur(24px) saturate(1.4)" }}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10px] px-2 py-0.5 w-full text-left cursor-pointer hover:bg-white/[0.02] transition-colors min-w-0"
      >
        <svg
          className={`h-2.5 w-2.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
        </svg>
        {pill}
        <span className="font-mono font-medium shrink-0">{label}</span>
        {usage && <span className="shrink-0 text-[8px] font-mono opacity-50">{usage.totalTokens} tok</span>}
        {!open && <span className="truncate opacity-60 min-w-0">{detail.slice(0, 80)}</span>}
      </button>
      {open && (
        <div className="px-2 pb-1.5 pt-0.5 text-[10px] whitespace-pre-wrap opacity-80 break-all border-t border-inherit">
          {detail}
          {usage && (
            <div className="mt-1 text-[8px] font-mono opacity-50 border-t border-inherit pt-1">
              {usage.totalTokens} tokens ({usage.promptTokens} in + {usage.completionTokens} out)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline grouping — nests pipeline child events under tool_call header
// ---------------------------------------------------------------------------

const PIPELINE_CHILD_ACTIONS = new Set([
  "code_review_llm_response", "code_review_llm_approved", "code_review_llm_rejected",
  "code_executed", "external_tool_result", "code_verified", "file_review_llm_response", "guardian_message",
  "code_review_passed", "code_review_rejected",
]);

type PipelineGroup = {
  _pipeline: true;
  agentShortId: string;
  headerEvent: OrchestrationSSEEvent & { type: "agent_activity" };
  childEvents: (OrchestrationSSEEvent & { type: "agent_activity" })[];
};

type GroupedItem = OrchestrationSSEEvent | PipelineGroup;

function isPipelineGroup(item: GroupedItem): item is PipelineGroup {
  return "_pipeline" in item;
}

function groupPipelineEvents(events: OrchestrationSSEEvent[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  const openGroups = new Map<string, PipelineGroup>();

  for (const event of events) {
    if (event.type !== "agent_activity") {
      result.push(event);
      continue;
    }

    // Check if this batch contains a tool_call for figma_plugin_execute
    const hasFigmaToolCall = event.activities.some(
      (a) => a.action === "tool_call" && a.toolName === "figma_plugin_execute"
    );

    if (hasFigmaToolCall) {
      const group: PipelineGroup = {
        _pipeline: true,
        agentShortId: event.agentShortId,
        headerEvent: event as OrchestrationSSEEvent & { type: "agent_activity" },
        childEvents: [],
      };
      openGroups.set(event.agentShortId, group);
      result.push(group);
      continue;
    }

    // Check if all activities in this batch are pipeline children
    const allPipeline = event.activities.every((a) => PIPELINE_CHILD_ACTIONS.has(a.action));
    const openGroup = openGroups.get(event.agentShortId);

    if (allPipeline && openGroup) {
      openGroup.childEvents.push(event as OrchestrationSSEEvent & { type: "agent_activity" });
      continue;
    }

    // Not a pipeline event — close any open group for this agent
    openGroups.delete(event.agentShortId);
    result.push(event);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pipeline group component — collapsible tool_call with nested children
// ---------------------------------------------------------------------------

function PipelineGroupBlock({
  group,
  agents,
  showAllEvents,
}: {
  group: PipelineGroup;
  agents: AgentViewState[];
  showAllEvents?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toolCallAct = group.headerEvent.activities.find(
    (a) => a.action === "tool_call" && a.toolName === "figma_plugin_execute"
  );
  if (!toolCallAct || toolCallAct.action !== "tool_call") return null;

  const usage = toolCallAct.usage;
  const childCount = group.childEvents.reduce((n, e) => n + e.activities.length, 0);

  // Find the execution result from children
  const execResult = group.childEvents
    .flatMap((e) => e.activities)
    .find((a) => a.action === "code_executed");
  const execOk = execResult?.action === "code_executed" && execResult.success;
  const fileReview = group.childEvents
    .flatMap((e) => e.activities)
    .find((a) => a.action === "file_review_llm_response");
  const reviewOk = fileReview?.action === "file_review_llm_response" && fileReview.status === "verified";

  // Status badge
  const statusLabel = execResult
    ? (reviewOk ? "VERIFIED" : execOk ? "OK" : "FAILED")
    : "...";
  const statusColor = reviewOk
    ? "text-emerald-400/70"
    : execOk
      ? "text-teal-400/60"
      : execResult ? "text-red-400/70" : "text-white/30";

  return (
    <div className="mx-2 sm:mx-4 my-0.5">
      <div
        className="rounded-lg border border-indigo-500/20 overflow-hidden"
        style={{ background: "rgba(10, 10, 10, 0.35)", backdropFilter: "blur(24px) saturate(1.4)" }}
      >
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 text-[10px] px-2.5 py-1 w-full text-left cursor-pointer hover:bg-white/[0.02] transition-colors min-w-0"
        >
          <svg
            className={`h-2.5 w-2.5 shrink-0 transition-transform opacity-40 ${open ? "rotate-90" : ""}`}
            viewBox="0 0 24 24" fill="currentColor"
          >
            <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
          </svg>
          <span className="text-[7px] px-1 py-px rounded border font-medium uppercase tracking-wider text-indigo-300/60 border-indigo-500/30 bg-indigo-500/10 shrink-0">
            exec
          </span>
          <span className="font-mono font-medium text-indigo-300/80 shrink-0">
            {group.agentShortId} figma_plugin_execute
          </span>
          <span className={`font-mono font-medium shrink-0 ${statusColor}`}>{statusLabel}</span>
          {usage && <span className="shrink-0 text-[8px] font-mono text-white/30">{usage.totalTokens} tok</span>}
          {childCount > 0 && <span className="shrink-0 text-[8px] text-white/20">{childCount} steps</span>}
          {!open && (
            <span className="truncate opacity-30 min-w-0 font-mono">
              {toolCallAct.summary.slice(0, 60)}
            </span>
          )}
        </button>
        {open && (
          <div className="border-t border-indigo-500/10 px-1 pb-1 pt-0.5">
            {/* Header activities (tool_call + code_review_passed) */}
            <div className="ml-3 mr-1 space-y-0.5 mb-0.5">
              {group.headerEvent.activities.map((act, ai) => (
                <AgentActivityItem key={`h-${ai}`} activity={act} agentShortId={group.agentShortId} />
              ))}
            </div>
            {/* Pipeline child events — nested */}
            <div className="ml-3 mr-1 space-y-0.5 border-l border-indigo-500/10 pl-2">
              {group.childEvents.map((childEvent, ci) =>
                childEvent.activities.map((act, ai) => (
                  <AgentActivityItem key={`c-${ci}-${ai}`} activity={act} agentShortId={childEvent.agentShortId} />
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OrchestrationEventLog({ events, agents, agentFilter, showAllEvents }: Props) {
  const visibleEvents = events.filter((e) => {
    if (!isVisibleEvent(e, showAllEvents)) return false;
    if (agentFilter) return matchesAgentFilter(e, agentFilter);
    return true;
  });

  if (visibleEvents.length === 0) return null;

  const grouped = groupPipelineEvents(visibleEvents);

  return (
    <div className="mt-2 mb-4">
      <div className="flex items-center gap-2 mx-4 mb-2">
        <div className="h-px flex-1 bg-amber-500/15" />
        <span className="text-[10px] text-amber-400/50 font-medium uppercase tracking-wider shrink-0">
          Orchestration
        </span>
        <div className="h-px flex-1 bg-amber-500/15" />
      </div>

      {grouped.map((item, i) =>
        isPipelineGroup(item)
          ? <PipelineGroupBlock key={i} group={item} agents={agents} showAllEvents={showAllEvents} />
          : renderEvent(item, i, agents, showAllEvents)
      )}
    </div>
  );
}
