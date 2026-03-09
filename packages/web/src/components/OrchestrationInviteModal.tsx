"use client";

import type { OrchestrationInvitePayload } from "@/types/orchestration";

type Props = {
  invite: OrchestrationInvitePayload;
  onAccept: (orchestrationId: string) => void;
  onDecline: (orchestrationId: string) => void;
};

/**
 * Modal shown when receiving an orchestration invite from another agent.
 * Displays the task description, context, and expected result.
 * Hidden when auto-accept is enabled.
 */
export function OrchestrationInviteModal({ invite, onAccept, onDecline }: Props) {
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => onDecline(invite.orchestrationId)}
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-md mx-4 rounded-xl border border-white/15 overflow-hidden"
        style={{
          background: "rgba(10,10,10,0.85)",
          backdropFilter: "blur(20px) saturate(1.5)",
          WebkitBackdropFilter: "blur(20px) saturate(1.5)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)",
        }}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-amber-400"
              >
                <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4-4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-medium text-white/90">
                Collaboration Request
              </h3>
              <p className="text-[11px] text-white/40">
                From {invite.senderShortId}
              </p>
            </div>
          </div>
        </div>

        {/* Task description */}
        <div className="px-5 pb-4 space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/30 block mb-1">
              Task
            </label>
            <p className="text-xs text-white/70 leading-relaxed">
              {invite.task}
            </p>
          </div>

          {invite.expectedResult && (
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/30 block mb-1">
                Expected result
              </label>
              <p className="text-xs text-white/50 leading-relaxed">
                {invite.expectedResult}
              </p>
            </div>
          )}

          {Object.keys(invite.context).length > 0 && (
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/30 block mb-1">
                Context
              </label>
              <pre className="text-[11px] text-white/40 bg-white/5 rounded-md p-2 overflow-x-auto max-h-32">
                {JSON.stringify(invite.context, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-5 py-3 flex gap-2 justify-end border-t border-white/10">
          <button
            onClick={() => onDecline(invite.orchestrationId)}
            className="px-4 py-1.5 text-xs text-white/50 hover:text-white/70 rounded-md hover:bg-white/5 transition-colors cursor-pointer"
          >
            Decline
          </button>
          <button
            onClick={() => onAccept(invite.orchestrationId)}
            className="px-4 py-1.5 text-xs text-white/90 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 rounded-md transition-colors cursor-pointer"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
