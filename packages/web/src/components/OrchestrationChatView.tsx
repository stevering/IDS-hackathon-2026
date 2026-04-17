"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OrchestrationSSEEvent, AgentViewState, AgentActivity } from "@guardian/orchestrations";
import { ThinkingBlock } from "@/components/chat/ThinkingBlock";
import { ToolCallBlock } from "@/components/chat/ToolCallBlock";
import { ToolCallProgress } from "@/components/chat/ToolCallProgress";
import { AgentMessageBubble } from "@/components/AgentMessageBubble";

type Props = {
  events: OrchestrationSSEEvent[];
  agents: AgentViewState[];
  agentFilter?: string;
};

function isVisibleInChatMode(e: OrchestrationSSEEvent): boolean {
  switch (e.type) {
    case "orchestration_started":
    case "orchestration_completed":
    case "agent_status_changed":
    case "orchestrator_text":
    case "orchestrator_reasoning":
    case "orchestrator_brief":
    case "orchestrator_directive":
    case "orchestrator_tool_call":
    case "orchestrator_tool_result":
    case "agent_report":
    case "agent_activity":
    case "user_input_received":
    case "peer_message":
    case "broadcast_message":
    case "guardrail_blocked":
    case "error":
      return true;
    default:
      return false;
  }
}

function LifecycleDivider({ label, detail, variant }: {
  label: string;
  detail?: string;
  variant: "start" | "end" | "status" | "error";
}) {
  const colors = {
    start: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400/80",
    end: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400/80",
    status: "bg-white/[0.04] border-white/10 text-white/50",
    error: "bg-red-500/10 border-red-500/20 text-red-400/80",
  };
  return (
    <div className="flex justify-center my-3">
      <div className={`inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs border ${colors[variant]}`}>
        <span className="font-medium">{label}</span>
        {detail && <span className="opacity-60">{detail}</span>}
      </div>
    </div>
  );
}

function ActivityPills({ activities }: { activities: AgentActivity[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 ml-4 my-1">
      {activities.map((a, i) => {
        let label: string;
        let color: string;

        switch (a.action) {
          case "reasoning":
            label = "Reasoning...";
            color = "bg-violet-500/10 text-violet-300/70 border-violet-500/15";
            break;
          case "assistant_text":
            label = "Responding...";
            color = "bg-sky-500/10 text-sky-300/70 border-sky-500/15";
            break;
          case "tool_call":
            label = `Tool: ${a.toolName}`;
            color = "bg-amber-500/10 text-amber-300/70 border-amber-500/15";
            break;
          case "code_review_passed":
          case "code_review_llm_approved":
            label = "Code review ✓";
            color = "bg-emerald-500/10 text-emerald-300/70 border-emerald-500/15";
            break;
          case "code_review_rejected":
          case "code_review_llm_rejected":
            label = "Code review ✗";
            color = "bg-red-500/10 text-red-300/70 border-red-500/15";
            break;
          case "code_executed":
            label = a.success ? "Executed ✓" : "Executed ✗";
            color = a.success
              ? "bg-emerald-500/10 text-emerald-300/70 border-emerald-500/15"
              : "bg-red-500/10 text-red-300/70 border-red-500/15";
            break;
          case "code_verified":
            label = "Verified ✓";
            color = "bg-emerald-500/10 text-emerald-300/70 border-emerald-500/15";
            break;
          default:
            label = a.action.replace(/_/g, " ");
            color = "bg-white/[0.06] text-white/40 border-white/10";
        }

        return (
          <span key={i} className={`text-[10px] px-2 py-0.5 rounded-full border ${color}`}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

function findAgentLabel(agents: AgentViewState[], shortId: string): string {
  const agent = agents.find(a => a.shortId === shortId);
  return agent?.label || shortId;
}

export function OrchestrationChatView({ events, agents, agentFilter }: Props) {
  const visible = events.filter(e => {
    if (!isVisibleInChatMode(e)) return false;
    if (agentFilter) {
      if (e.type === "orchestration_started" || e.type === "orchestration_completed" || e.type === "error") return true;
      if ("agentShortId" in e && e.agentShortId !== agentFilter) return false;
      if (e.type === "peer_message" && e.fromAgentId !== agentFilter && e.toAgentId !== agentFilter) return false;
      if (e.type === "broadcast_message" && e.fromAgentId !== agentFilter) return false;
    }
    return true;
  });

  // Track in-flight tool calls for progress display
  const pendingTools = new Set<string>();
  const completedTools = new Set<string>();

  return (
    <div className="space-y-1 py-4">
      {visible.map((event, idx) => {
        switch (event.type) {
          // ── Lifecycle dividers ──
          case "orchestration_started": {
            const agentLabels = event.agents.map(a => a.label || a.shortId).join(", ");
            return <LifecycleDivider key={idx} label="Orchestration started" detail={`with ${agentLabels}`} variant="start" />;
          }
          case "orchestration_completed":
            return (
              <LifecycleDivider
                key={idx}
                label={
                  event.status === "completed" ? "Orchestration completed" :
                  event.status === "completed_with_errors" ? "Completed with errors" :
                  event.status === "failed" ? "Orchestration failed" :
                  event.status === "cancelled" ? "Orchestration cancelled" :
                  "Orchestration timed out"
                }
                detail={event.error}
                variant={event.status === "completed" ? "end" : "error"}
              />
            );
          case "agent_status_changed":
            return (
              <LifecycleDivider
                key={idx}
                label={`${findAgentLabel(agents, event.agentShortId)}`}
                detail={event.status}
                variant={event.status === "completed" ? "end" : event.status === "failed" ? "error" : "status"}
              />
            );
          case "error":
            return <LifecycleDivider key={idx} label="Error" detail={event.message} variant="error" />;

          // ── User messages (right-aligned, blue bubble) ──
          case "user_input_received":
            return (
              <div key={idx} className="flex justify-end mb-3 px-2">
                <div className="glass-msg-user rounded-2xl px-4 py-2.5 max-w-[80%]">
                  <div className="text-sm leading-relaxed">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
                  </div>
                </div>
              </div>
            );

          // ── Orchestrator text (left-aligned, assistant bubble) ──
          case "orchestrator_text": {
            return (
              <div key={idx} className="mb-3 px-2">
                <div className="text-[10px] text-amber-400/50 font-medium mb-1 ml-1">Orchestrator</div>
                <div className="glass-msg-ai rounded-2xl px-4 py-2.5 max-w-[85%]">
                  <div className="text-sm leading-relaxed prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
                  </div>
                  {(event.usage || event.modelId) && (
                    <div className="mt-1.5 text-[9px] font-mono text-white/20">
                      {event.modelId && <span>{event.modelId}</span>}
                      {event.hadReasoning && <span className="text-violet-400/40"> reasoning</span>}
                      {event.usage && <span>{event.modelId ? " · " : ""}{event.usage.totalTokens} tokens</span>}
                    </div>
                  )}
                </div>
              </div>
            );
          }

          // ── Orchestrator reasoning (thinking block) ──
          case "orchestrator_reasoning":
            return (
              <div key={idx} className="px-2 mb-1">
                <ThinkingBlock
                  text={event.content}
                  isLast={idx === visible.length - 1}
                  isStreaming={false}
                />
              </div>
            );

          // ── Orchestrator briefing ──
          case "orchestrator_brief":
            return (
              <div key={idx} className="mb-3 px-2">
                <div className="text-[10px] text-sky-400/50 font-medium mb-1 ml-1">Briefing</div>
                <div className="glass-msg-ai rounded-2xl px-4 py-2.5 max-w-[85%] border-sky-500/10">
                  <div className="text-sm leading-relaxed prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
                  </div>
                </div>
              </div>
            );

          // ── Orchestrator directive → agent ──
          case "orchestrator_directive":
            return (
              <div key={idx} className="mb-3 px-2">
                <div className="text-[10px] text-amber-400/50 font-medium mb-1 ml-1">
                  Orchestrator → {findAgentLabel(agents, event.agentShortId)}
                </div>
                <div className="ml-2 rounded-xl px-4 py-2.5 max-w-[85%] border border-amber-500/15 bg-amber-500/[0.04]"
                  style={{ backdropFilter: "blur(12px)" }}>
                  <div className="text-sm leading-relaxed text-amber-100/70 prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
                  </div>
                </div>
              </div>
            );

          // ── Tool calls ──
          case "orchestrator_tool_call": {
            const toolKey = `${event.toolName}-${idx}`;
            const hasResult = visible.slice(idx + 1).some(
              e => e.type === "orchestrator_tool_result" && e.toolName === event.toolName
            );
            if (hasResult) {
              pendingTools.delete(toolKey);
            } else {
              pendingTools.add(toolKey);
            }
            if (!hasResult) {
              return (
                <div key={idx} className="px-2">
                  <ToolCallProgress toolName={event.toolName} input={event.args} />
                </div>
              );
            }
            return null;
          }
          case "orchestrator_tool_result": {
            const toolKey = `${event.toolName}-result-${idx}`;
            if (completedTools.has(toolKey)) return null;
            completedTools.add(toolKey);
            const callEvent = [...visible].reverse().find(
              e => e.type === "orchestrator_tool_call" && e.toolName === event.toolName
            ) as Extract<OrchestrationSSEEvent, { type: "orchestrator_tool_call" }> | undefined;
            return (
              <div key={idx} className="px-2">
                <ToolCallBlock
                  toolName={event.toolName}
                  input={callEvent?.args}
                  output={event.result}
                  isError={event.isError}
                />
              </div>
            );
          }

          // ── Agent reports ──
          case "agent_report": {
            const report = event.report;
            if (!report) return null;
            return (
              <div key={idx} className="mb-3 px-2">
                <div className="text-[10px] text-violet-400/50 font-medium mb-1 ml-1">
                  {findAgentLabel(agents, event.agentShortId)}
                </div>
                <div className="ml-2 rounded-xl px-4 py-2.5 max-w-[85%] border border-violet-500/15 bg-violet-500/[0.04]"
                  style={{ backdropFilter: "blur(12px)" }}>
                  {report.summary && (
                    <div className="text-sm leading-relaxed text-violet-100/70 prose prose-invert prose-sm max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.summary}</ReactMarkdown>
                    </div>
                  )}
                  {report.changes && report.changes.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {report.changes.map((c, ci) => (
                        <div key={ci} className="flex items-center gap-2 text-xs text-violet-200/50">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            c.type === "delete" ? "bg-red-400" :
                            c.type === "create" ? "bg-emerald-400" :
                            "bg-amber-400"
                          }`} />
                          <span className="truncate">{c.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          }

          // ── Agent activity (compact pills) ──
          case "agent_activity":
            return (
              <div key={idx}>
                <div className="text-[10px] text-violet-400/40 font-medium ml-3 mb-0.5">
                  {findAgentLabel(agents, event.agentShortId)}
                </div>
                <ActivityPills activities={event.activities} />
              </div>
            );

          // ── Peer / broadcast messages ──
          case "peer_message":
            return (
              <div key={idx} className="px-2">
                <AgentMessageBubble
                  senderShortId={event.fromAgentId}
                  content={event.content}
                  mentions={[event.toAgentId]}
                />
              </div>
            );
          case "broadcast_message":
            return (
              <div key={idx} className="px-2">
                <AgentMessageBubble
                  senderShortId={event.fromAgentId}
                  content={event.content}
                />
              </div>
            );

          // ── Guardrail blocked ──
          case "guardrail_blocked":
            return (
              <div key={idx} className="mx-2 my-2 p-3 rounded-lg border border-red-500/20 bg-red-500/[0.04]">
                <div className="flex items-center gap-2 mb-1">
                  <svg className="h-3.5 w-3.5 text-red-400/70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span className="text-xs font-medium text-red-300/80">
                    Blocked: {event.blockedAction}
                  </span>
                  <span className="text-[10px] text-white/30">
                    {findAgentLabel(agents, event.agentShortId)}
                  </span>
                </div>
                <p className="text-xs text-red-200/50 ml-5">{event.reason}</p>
              </div>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}
