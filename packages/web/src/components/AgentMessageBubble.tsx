"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  senderShortId: string;
  content: string;
  isOrchestrator?: boolean;
  timestamp?: string;
  mentions?: string[];
};

/**
 * A distinct chat bubble for inter-agent messages in Collaborative Agents mode.
 * Visually muted compared to regular user/assistant messages to differentiate
 * internal agent communication from the main conversation.
 */
export function AgentMessageBubble({
  senderShortId,
  content,
  isOrchestrator,
  timestamp,
  mentions,
}: Props) {
  const roleLabel = isOrchestrator ? "Orchestrator" : "Agent";
  const borderColor = isOrchestrator
    ? "border-amber-500/20"
    : "border-violet-500/20";
  const bgColor = isOrchestrator
    ? "bg-amber-500/5"
    : "bg-violet-500/5";
  const labelColor = isOrchestrator
    ? "text-amber-400/70"
    : "text-violet-400/70";

  return (
    <div className={`ml-4 mr-2 my-1.5 rounded-lg border ${borderColor} ${bgColor} px-3 py-2`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        {/* Agent icon */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`shrink-0 ${labelColor}`}
        >
          <path d="M12 2a4 4 0 014 4v1h2a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2h2V6a4 4 0 014-4z" />
          <circle cx="9" cy="13" r="1" fill="currentColor" />
          <circle cx="15" cy="13" r="1" fill="currentColor" />
        </svg>

        <span className={`text-[10px] font-medium ${labelColor}`}>
          {roleLabel} {senderShortId}
        </span>

        {mentions && mentions.length > 0 && (
          <span className="text-[10px] text-white/30">
            &rarr; {mentions.join(", ")}
          </span>
        )}

        {timestamp && (
          <span className="text-[10px] text-white/20 ml-auto">
            {new Date(timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="text-xs text-white/60 leading-relaxed prose prose-invert prose-xs max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
