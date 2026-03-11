"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { createClient } from "@/lib/supabase/client";
import type {
  AgentRole,
  Orchestration,
  OrchestrationInvitePayload,
  OrchestrationAcceptPayload,
  OrchestrationDeclinePayload,
  AgentRequestPayload,
  AgentResponsePayload,
  AgentMessagePayload,
  OrchestrationTickPayload,
  OrchestrationEndPayload,
  SubConversationStartPayload,
  SubConversationEndPayload,
  UserCollaborationSettings,
} from "@/types/orchestration";

/** Match shortId with suffix support — LLM may abbreviate "#Figma-Desktop-zivihi" to "#zivihi" */
export function matchesShortId(fullShortId: string | undefined, abbreviated: string): boolean {
  if (!fullShortId) return false;
  if (fullShortId === abbreviated) return true;
  const full = fullShortId.replace(/^#/, "");
  const abbr = abbreviated.replace(/^#/, "");
  return full.endsWith(`-${abbr}`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollaboratorInfo = {
  clientId: string;
  shortId: string;
  label: string;
  status: "invited" | "active" | "completed" | "standby";
  conversationId?: string;
  task?: string;
};

/** Sub-conversation state tracking */
export type SubConversation = {
  id: string;
  initiatorClientId: string;
  initiatorShortId: string;
  targetClientId: string;
  topic: string;
  startedAt: number;
  durationMs: number;
  status: "active" | "completed" | "timeout";
};

/** Timer constants */
const ORCHESTRATION_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const TICK_INTERVAL_MS = 30_000; // broadcast tick every 30s
const SUB_CONVERSATION_DEFAULT_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Callback map that useFigmaExecuteChannel invokes when it receives
 * orchestration-specific broadcast events. useOrchestration registers
 * its handlers here so the two hooks stay decoupled.
 */
export type OrchestrationCallbacks = {
  onInvite?: (payload: OrchestrationInvitePayload) => void;
  onAccept?: (payload: OrchestrationAcceptPayload) => void;
  onDecline?: (payload: OrchestrationDeclinePayload) => void;
  onAgentRequest?: (payload: AgentRequestPayload) => void;
  onAgentResponse?: (payload: AgentResponsePayload) => void;
  onAgentMessage?: (payload: AgentMessagePayload) => void;
  onTick?: (payload: OrchestrationTickPayload) => void;
  onEnd?: (payload: OrchestrationEndPayload) => void;
  onSubConversationStart?: (payload: SubConversationStartPayload) => void;
  onSubConversationEnd?: (payload: SubConversationEndPayload) => void;
};

export type UseOrchestrationReturn = {
  // State
  role: AgentRole;
  orchestration: Orchestration | null;
  collaborators: CollaboratorInfo[];
  pendingInvites: OrchestrationInvitePayload[];
  settings: UserCollaborationSettings;
  timerRemainingMs: number | null; // ms remaining in orchestration, null if no timer
  startedAt: number | null; // epoch ms when orchestration started
  activeSubConversation: SubConversation | null;

  // Orchestrator actions
  becomeOrchestrator: (conversationId: string) => Promise<string | null>;
  inviteCollaborator: (
    targetClientId: string,
    task: string,
    context: Record<string, unknown>,
    expectedResult?: string,
    targetShortId?: string,
    targetLabel?: string,
  ) => void;
  sendAgentRequest: (
    targetClientId: string,
    content: string,
    context: Record<string, unknown>,
    expectedResult?: string,
    wantScreenshot?: boolean,
  ) => void;
  completeOrchestration: (status?: "completed" | "cancelled") => Promise<void>;

  // Collaborator actions
  acceptInvite: (orchestrationId: string) => Promise<string | null>;
  declineInvite: (orchestrationId: string) => void;
  sendAgentResponse: (
    requestId: string,
    status: "in_progress" | "completed" | "failed" | "needs_input",
    summary?: string,
    result?: Record<string, unknown>,
    screenshot?: string,
  ) => void;

  // Sub-conversation actions
  startSubConversation: (
    targetClientId: string,
    topic: string,
    durationMs?: number,
  ) => void;
  endSubConversation: (reason?: "completed" | "cancelled") => void;

  // Shared actions
  sendAgentMessage: (
    content: string,
    mentions?: string[],
    insertInActive?: boolean,
    excludeClientIds?: string[],
  ) => void;
  markCollaboratorDone: (shortId: string) => void;
  updateSettings: (autoAccept: boolean) => Promise<void>;
  releaseRole: () => Promise<void>;

  // External event callback refs (set by page.tsx)
  onAgentRequest: React.MutableRefObject<((payload: AgentRequestPayload) => void) | null>;
  onAgentResponse: React.MutableRefObject<((payload: AgentResponsePayload) => void) | null>;
  onAgentMessage: React.MutableRefObject<((payload: AgentMessagePayload) => void) | null>;
  onCollaboratorReady: React.MutableRefObject<((senderId: string, senderShortId: string) => void) | null>;

  // Orchestration callbacks ref for useFigmaExecuteChannel integration
  orchestrationCallbacksRef: React.RefObject<OrchestrationCallbacks>;
};

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: UserCollaborationSettings = { autoAccept: false };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Core state machine hook for the Collaborative Agents mode.
 *
 * Reuses the existing Supabase RT channel (passed via channelRef from
 * useFigmaExecuteChannel) instead of creating its own. Outgoing messages
 * are sent via `channelRef.current.send()`. Incoming orchestration events
 * are received through the `orchestrationCallbacksRef` that
 * useFigmaExecuteChannel invokes.
 */
export function useOrchestration(
  clientId: string,
  shortId: string | null,
  channelRef: React.RefObject<ReturnType<ReturnType<typeof createClient>["channel"]> | null>,
  enabled: boolean,
): UseOrchestrationReturn {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const [role, setRole] = useState<AgentRole>("idle");
  const [orchestration, setOrchestration] = useState<Orchestration | null>(null);
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([]);
  const [pendingInvites, setPendingInvites] = useState<OrchestrationInvitePayload[]>([]);
  const [settings, setSettings] = useState<UserCollaborationSettings>(DEFAULT_SETTINGS);

  // Timer state
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [timerRemainingMs, setTimerRemainingMs] = useState<number | null>(null);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sub-conversation state
  const [activeSubConversation, setActiveSubConversation] = useState<SubConversation | null>(null);
  const subConvTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable refs to avoid stale closures
  const clientIdRef = useRef(clientId);
  clientIdRef.current = clientId;
  const shortIdRef = useRef(shortId);
  shortIdRef.current = shortId;
  const orchestrationRef = useRef(orchestration);
  orchestrationRef.current = orchestration;
  const roleRef = useRef(role);
  roleRef.current = role;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const collaboratorsRef = useRef(collaborators);
  collaboratorsRef.current = collaborators;
  const startedAtRef = useRef(startedAt);
  startedAtRef.current = startedAt;

  // External event callback refs (page.tsx sets these)
  const onAgentRequest = useRef<((payload: AgentRequestPayload) => void) | null>(null);
  const onAgentResponse = useRef<((payload: AgentResponsePayload) => void) | null>(null);
  const onAgentMessage = useRef<((payload: AgentMessagePayload) => void) | null>(null);
  // Called when a collaborator accepts (orchestrator side) — page.tsx uses this to notify the AI
  const onCollaboratorReady = useRef<((senderId: string, senderShortId: string) => void) | null>(null);

  // Forward ref so onAccept can call sendAgentRequest (defined later)
  const sendAgentRequestRef = useRef<UseOrchestrationReturn["sendAgentRequest"] | null>(null);
  // Dedup: track orchestration IDs we've already accepted (prevents triple sub-conversations
  // when Supabase RT delivers the same invite multiple times)
  const acceptedOrchestrations = useRef(new Set<string>());

  // -------------------------------------------------------------------------
  // Orchestration callbacks ref (consumed by useFigmaExecuteChannel)
  // -------------------------------------------------------------------------
  const orchestrationCallbacksRef = useRef<OrchestrationCallbacks>({});

  // -------------------------------------------------------------------------
  // Accept invite (declared early so onInvite can reference it for autoAccept)
  // -------------------------------------------------------------------------
  const acceptInvite = useCallback(async (orchestrationId: string): Promise<string | null> => {
    // Dedup: skip if we already accepted this orchestration (keyed by clientId+orchestrationId)
    const dedupKey = `${clientIdRef.current}:${orchestrationId}`;
    if (acceptedOrchestrations.current.has(dedupKey)) return null;
    acceptedOrchestrations.current.add(dedupKey);

    try {
      // Find the matching invite to get conversation context
      const invite = pendingInvites.find((inv) => inv.orchestrationId === orchestrationId);

      // Create a sub-conversation for the collaborator, including clientId
      // so the server can deduplicate if needed
      const convRes = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Collaborative task",
          clientId: clientIdRef.current,
          parentId: null,
          orchestrationId,
        }),
      });
      if (!convRes.ok) {
        console.warn("[Orchestration] Failed to create sub-conversation:", await convRes.text());
        return null;
      }
      const convData = await convRes.json();
      const newConversationId: string = convData.conversationId ?? convData.id;

      // Update client role on the server
      await fetch("/api/clients/role", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientIdRef.current,
          role: "collaborator",
          orchestrationId,
        }),
      });

      // Broadcast acceptance on the channel
      const ch = channelRef.current;
      if (ch) {
        const acceptPayload: OrchestrationAcceptPayload = {
          orchestrationId,
          senderId: clientIdRef.current,
          senderShortId: shortIdRef.current ?? clientIdRef.current,
          conversationId: invite?.conversationId ?? "",
          accepted: true,
          collaboratorConversationId: newConversationId,
        };
        ch.send({ type: "broadcast", event: "orchestration_accept", payload: acceptPayload });
      }

      // Update local state
      setRole("collaborator");
      setOrchestration({
        id: orchestrationId,
        userId: "",
        orchestratorClientId: invite?.senderId ?? "",
        conversationId: invite?.conversationId ?? "",
        status: "active",
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      setPendingInvites((prev) => prev.filter((inv) => inv.orchestrationId !== orchestrationId));

      return newConversationId;
    } catch (err) {
      console.warn("[Orchestration] acceptInvite failed:", err);
      return null;
    }
  }, [channelRef, pendingInvites]);

  // -------------------------------------------------------------------------
  // Register orchestration callbacks
  // -------------------------------------------------------------------------
  useEffect(() => {
    orchestrationCallbacksRef.current = {
      onInvite: (payload: OrchestrationInvitePayload) => {
        // Ignore invites from ourselves
        if (payload.senderId === clientIdRef.current) return;
        // Ignore if already accepted/processing this orchestration
        const dedupKey = `${clientIdRef.current}:${payload.orchestrationId}`;
        if (acceptedOrchestrations.current.has(dedupKey)) return;

        if (settingsRef.current.autoAccept) {
          // Auto-accept: do not add to pending, accept immediately
          acceptInvite(payload.orchestrationId);
          return;
        }

        setPendingInvites((prev) => {
          // Deduplicate by orchestrationId
          if (prev.some((inv) => inv.orchestrationId === payload.orchestrationId)) return prev;
          return [...prev, payload];
        });
      },

      onAccept: (payload: OrchestrationAcceptPayload) => {
        // Only the orchestrator cares about accept events
        if (roleRef.current !== "orchestrator") return;

        setCollaborators((prev) =>
          prev.map((c) =>
            c.clientId === payload.senderId
              ? { ...c, status: "active" as const, conversationId: payload.collaboratorConversationId }
              : c,
          ),
        );

        // Notify page.tsx so the AI can decompose and delegate tasks
        onCollaboratorReady.current?.(payload.senderId, payload.senderShortId);
      },

      onDecline: (payload: OrchestrationDeclinePayload) => {
        if (roleRef.current !== "orchestrator") return;
        setCollaborators((prev) =>
          prev.filter((c) => c.clientId !== payload.senderId),
        );
      },

      onAgentRequest: (payload: AgentRequestPayload) => {
        onAgentRequest.current?.(payload);
      },

      onAgentResponse: (payload: AgentResponsePayload) => {
        // Ignore responses from a different orchestration (ghost reports from previous sessions)
        const currentOrch = orchestrationRef.current;
        if (currentOrch && payload.orchestrationId && payload.orchestrationId !== currentOrch.id) return;

        // Orchestrator: update collaborator status when they report completion
        if (roleRef.current === "orchestrator" && payload.status === "completed") {
          setCollaborators((prev) =>
            prev.map((c) =>
              c.clientId === payload.senderId
                ? { ...c, status: "completed" as const }
                : c,
            ),
          );
        }
        onAgentResponse.current?.(payload);
      },

      onAgentMessage: (payload: AgentMessagePayload) => {
        // Skip if this client is in the exclude list (e.g. auto-relay excludes the original sender)
        if (payload.excludeClientIds?.includes(clientIdRef.current)) return;
        onAgentMessage.current?.(payload);
      },

      onTick: (payload: OrchestrationTickPayload) => {
        // Collaborators update their local timer from orchestrator ticks
        if (roleRef.current === "collaborator") {
          setTimerRemainingMs(payload.remainingMs);
          if (!startedAtRef.current) {
            setStartedAt(new Date(payload.startedAt).getTime());
          }
        }
      },

      onEnd: (payload: OrchestrationEndPayload) => {
        // Collaborator receives end signal from orchestrator → reset to idle
        if (roleRef.current === "collaborator") {
          // Clean up timers
          if (tickIntervalRef.current) { clearInterval(tickIntervalRef.current); tickIntervalRef.current = null; }
          if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }
          if (subConvTimeoutRef.current) { clearTimeout(subConvTimeoutRef.current); subConvTimeoutRef.current = null; }

          setRole("idle");
          setOrchestration(null);
          setStartedAt(null);
          setTimerRemainingMs(null);
          setActiveSubConversation(null);
        }
      },

      onSubConversationStart: (payload: SubConversationStartPayload) => {
        // Target agent receives sub-conversation request
        if (payload.targetClientId === clientIdRef.current) {
          setActiveSubConversation({
            id: payload.subConversationId,
            initiatorClientId: payload.initiatorClientId,
            initiatorShortId: payload.initiatorShortId,
            targetClientId: payload.targetClientId,
            topic: payload.topic,
            startedAt: Date.now(),
            durationMs: payload.durationMs,
            status: "active",
          });
        }
      },

      onSubConversationEnd: (payload: SubConversationEndPayload) => {
        setActiveSubConversation((prev) => {
          if (!prev || prev.id !== payload.subConversationId) return prev;
          return null;
        });
        if (subConvTimeoutRef.current) {
          clearTimeout(subConvTimeoutRef.current);
          subConvTimeoutRef.current = null;
        }
      },
    };
  }, [acceptInvite]);

  // -------------------------------------------------------------------------
  // Fetch initial settings & clean up stale roles on mount
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;

    fetch("/api/user/settings")
      .then((res) => {
        if (!res.ok) throw new Error("Settings fetch failed");
        return res.json();
      })
      .then((data) => {
        setSettings({ autoAccept: data.autoAccept ?? false });
      })
      .catch((err) => {
        console.warn("[Orchestration] Failed to fetch settings:", err);
      });

    // Release any stale role from a previous session (e.g. page refresh mid-orchestration)
    if (clientId) {
      fetch("/api/clients/role", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, role: "idle", orchestrationId: null }),
      }).catch(() => {});
    }
  }, [enabled, clientId]);

  // -------------------------------------------------------------------------
  // Orchestrator actions
  // -------------------------------------------------------------------------

  const becomeOrchestrator = useCallback(async (conversationId: string): Promise<string | null> => {
    try {
      // Release any stale role first (e.g. from a previous failed orchestration)
      if (roleRef.current !== "idle") {
        await fetch("/api/clients/role", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: clientIdRef.current, role: "idle", orchestrationId: null }),
        });
      }

      const res = await fetch("/api/orchestrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientIdRef.current,
          conversationId,
        }),
      });
      if (!res.ok) {
        console.warn("[Orchestration] becomeOrchestrator failed:", await res.text());
        return null;
      }

      const data = await res.json();
      const orchestrationId: string = data.orchestrationId;

      const orch: Orchestration = {
        id: orchestrationId,
        userId: "",
        orchestratorClientId: clientIdRef.current,
        conversationId,
        status: "active",
        createdAt: new Date().toISOString(),
        completedAt: null,
      };

      // Update refs synchronously so that inviteCollaborator (called right
      // after in the same tick) can read the new values immediately.
      roleRef.current = "orchestrator";
      orchestrationRef.current = orch;

      // Start the 10-minute timer
      const now = Date.now();
      startedAtRef.current = now;

      // Then schedule state updates for React re-render
      setRole("orchestrator");
      setOrchestration(orch);
      setCollaborators([]);
      setStartedAt(now);
      setTimerRemainingMs(ORCHESTRATION_DURATION_MS);

      return orchestrationId;
    } catch (err) {
      console.warn("[Orchestration] becomeOrchestrator error:", err);
      return null;
    }
  }, []);

  const inviteCollaborator = useCallback(
    (
      targetClientId: string,
      task: string,
      context: Record<string, unknown>,
      expectedResult?: string,
      targetShortId?: string,
      targetLabel?: string,
    ) => {
      const orch = orchestrationRef.current;
      if (!orch) {
        console.warn("[Orchestration] Cannot invite: no active orchestration");
        return;
      }

      const ch = channelRef.current;
      if (!ch) {
        console.warn("[Orchestration] Cannot invite: no channel");
        return;
      }

      const payload: OrchestrationInvitePayload = {
        orchestrationId: orch.id,
        senderId: clientIdRef.current,
        senderShortId: shortIdRef.current ?? clientIdRef.current,
        conversationId: orch.conversationId,
        task,
        context,
        expectedResult,
      };

      ch.send({ type: "broadcast", event: "orchestration_invite", payload });

      // Add to local collaborators list with 'invited' status
      setCollaborators((prev) => {
        if (prev.some((c) => c.clientId === targetClientId)) return prev;
        return [
          ...prev,
          {
            clientId: targetClientId,
            shortId: targetShortId ?? targetClientId,
            label: targetLabel ?? targetClientId,
            status: "invited" as const,
            task,
          },
        ];
      });
    },
    [channelRef],
  );

  const sendAgentRequest = useCallback(
    (
      targetClientId: string,
      content: string,
      context: Record<string, unknown>,
      expectedResult?: string,
      wantScreenshot?: boolean,
    ) => {
      const orch = orchestrationRef.current;
      if (!orch) return;

      const ch = channelRef.current;
      if (!ch) return;

      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const payload: AgentRequestPayload = {
        orchestrationId: orch.id,
        senderId: clientIdRef.current,
        senderShortId: shortIdRef.current ?? clientIdRef.current,
        conversationId: orch.conversationId,
        requestId,
        targetClientId,
        content,
        context,
        expectedResult,
        wantScreenshot,
      };

      ch.send({ type: "broadcast", event: "agent_request", payload });
    },
    [channelRef],
  );

  // Wire the ref so onAccept can call sendAgentRequest
  sendAgentRequestRef.current = sendAgentRequest;

  const completeOrchestration = useCallback(
    async (status: "completed" | "cancelled" = "completed"): Promise<void> => {
      const orch = orchestrationRef.current;
      if (!orch) return;

      // Broadcast orchestration_end to all collaborators so they can go idle
      const ch = channelRef.current;
      if (ch) {
        const endPayload: OrchestrationEndPayload = {
          orchestrationId: orch.id,
          senderId: clientIdRef.current,
          senderShortId: shortIdRef.current ?? clientIdRef.current,
          conversationId: orch.conversationId,
        };
        ch.send({ type: "broadcast", event: "orchestration_end", payload: endPayload });
      }

      try {
        await fetch(`/api/orchestrations/${orch.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
      } catch (err) {
        console.warn("[Orchestration] completeOrchestration failed:", err);
      }

      // Clean up timers
      if (tickIntervalRef.current) { clearInterval(tickIntervalRef.current); tickIntervalRef.current = null; }
      if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }
      if (subConvTimeoutRef.current) { clearTimeout(subConvTimeoutRef.current); subConvTimeoutRef.current = null; }

      // Reset local state regardless of API outcome
      setRole("idle");
      setOrchestration(null);
      setCollaborators([]);
      setStartedAt(null);
      setTimerRemainingMs(null);
      setActiveSubConversation(null);
    },
    [channelRef],
  );

  // -------------------------------------------------------------------------
  // Collaborator actions
  // -------------------------------------------------------------------------

  const declineInvite = useCallback(
    (orchestrationId: string) => {
      const ch = channelRef.current;

      // Find the invite to get the orchestrator's conversationId
      const invite = pendingInvites.find((inv) => inv.orchestrationId === orchestrationId);

      if (ch) {
        const payload: OrchestrationDeclinePayload = {
          orchestrationId,
          senderId: clientIdRef.current,
          senderShortId: shortIdRef.current ?? clientIdRef.current,
          conversationId: invite?.conversationId ?? "",
          accepted: false,
        };
        ch.send({ type: "broadcast", event: "orchestration_decline", payload });
      }

      setPendingInvites((prev) => prev.filter((inv) => inv.orchestrationId !== orchestrationId));
    },
    [channelRef, pendingInvites],
  );

  const sendAgentResponse = useCallback(
    (
      requestId: string,
      status: "in_progress" | "completed" | "failed" | "needs_input",
      summary?: string,
      result?: Record<string, unknown>,
      screenshot?: string,
    ) => {
      const orch = orchestrationRef.current;
      if (!orch) return;

      const ch = channelRef.current;
      if (!ch) return;

      const payload: AgentResponsePayload = {
        orchestrationId: orch.id,
        senderId: clientIdRef.current,
        senderShortId: shortIdRef.current ?? clientIdRef.current,
        conversationId: orch.conversationId,
        requestId,
        status,
        summary,
        result,
        screenshot,
      };

      ch.send({ type: "broadcast", event: "agent_response", payload });
    },
    [channelRef],
  );

  // -------------------------------------------------------------------------
  // Shared actions
  // -------------------------------------------------------------------------

  const sendAgentMessage = useCallback(
    (content: string, mentions?: string[], insertInActive?: boolean, excludeClientIds?: string[]) => {
      const orch = orchestrationRef.current;
      if (!orch) return;

      const ch = channelRef.current;
      if (!ch) return;

      const payload: AgentMessagePayload = {
        orchestrationId: orch.id,
        senderId: clientIdRef.current,
        senderShortId: shortIdRef.current ?? clientIdRef.current,
        conversationId: orch.conversationId,
        content,
        mentions,
        insertInActive,
        excludeClientIds,
      };

      ch.send({ type: "broadcast", event: "agent_message", payload });
    },
    [channelRef],
  );

  const markCollaboratorDone = useCallback((shortId: string) => {
    setCollaborators((prev) => {
      // Skip update if already completed — avoids creating a new array reference
      // which would reset the auto-end timer in the useEffect that depends on collaborators.
      const target = prev.find((c) => matchesShortId(c.shortId, shortId));
      if (!target || target.status === "completed") return prev;
      return prev.map((c) =>
        matchesShortId(c.shortId, shortId) ? { ...c, status: "completed" as const } : c,
      );
    });
  }, []);

  const updateSettings = useCallback(async (autoAccept: boolean): Promise<void> => {
    try {
      const res = await fetch("/api/user/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoAccept }),
      });
      if (res.ok) {
        setSettings({ autoAccept });
      }
    } catch (err) {
      console.warn("[Orchestration] updateSettings failed:", err);
    }
  }, []);

  const releaseRole = useCallback(async (): Promise<void> => {
    try {
      await fetch("/api/clients/role", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientIdRef.current,
          role: "idle",
          orchestrationId: null,
        }),
      });
    } catch (err) {
      console.warn("[Orchestration] releaseRole failed:", err);
    }

    // Clean up timers
    if (tickIntervalRef.current) { clearInterval(tickIntervalRef.current); tickIntervalRef.current = null; }
    if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }
    if (subConvTimeoutRef.current) { clearTimeout(subConvTimeoutRef.current); subConvTimeoutRef.current = null; }

    setRole("idle");
    setOrchestration(null);
    setCollaborators([]);
    setPendingInvites([]);
    setStartedAt(null);
    setTimerRemainingMs(null);
    setActiveSubConversation(null);
  }, []);

  // -------------------------------------------------------------------------
  // Timer: tick every second for UI + broadcast tick every 30s
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (role !== "orchestrator" || !startedAt) return;

    // Local UI timer — tick every second
    timerIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, ORCHESTRATION_DURATION_MS - elapsed);
      setTimerRemainingMs(remaining);

      // Auto-complete when timer expires
      if (remaining <= 0) {
        console.log("[Orchestration] Timer expired — auto-completing orchestration");
        completeOrchestration("completed");
      }
    }, 1000);

    // Broadcast tick every 30s so collaborators see the countdown
    tickIntervalRef.current = setInterval(() => {
      const ch = channelRef.current;
      const orch = orchestrationRef.current;
      if (!ch || !orch) return;

      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, ORCHESTRATION_DURATION_MS - elapsed);

      const payload: OrchestrationTickPayload = {
        orchestrationId: orch.id,
        senderId: clientIdRef.current,
        senderShortId: shortIdRef.current ?? clientIdRef.current,
        conversationId: orch.conversationId,
        remainingMs: remaining,
        totalMs: ORCHESTRATION_DURATION_MS,
        startedAt: new Date(startedAt).toISOString(),
      };
      ch.send({ type: "broadcast", event: "orchestration_tick", payload });
    }, TICK_INTERVAL_MS);

    return () => {
      if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }
      if (tickIntervalRef.current) { clearInterval(tickIntervalRef.current); tickIntervalRef.current = null; }
    };
  }, [role, startedAt, channelRef, completeOrchestration]);

  // -------------------------------------------------------------------------
  // Auto-end orchestration when all collaborators have completed
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (role !== "orchestrator") return;
    if (collaborators.length === 0) return;
    const allDone = collaborators.every(c => c.status === "completed" || c.status === "standby");
    if (!allDone) return;

    const timer = setTimeout(() => {
      // Re-check: still orchestrator and all still done?
      if (roleRef.current === "orchestrator" && orchestrationRef.current) {
        console.log("[Orchestration] All collaborators completed — auto-ending after grace period");
        completeOrchestration("completed");
      }
    }, 15_000); // 15s grace period for orchestrator to finalize

    return () => clearTimeout(timer);
  }, [role, collaborators, completeOrchestration]);

  // -------------------------------------------------------------------------
  // Sub-conversation actions
  // -------------------------------------------------------------------------
  const startSubConversation = useCallback(
    (targetClientId: string, topic: string, durationMs: number = SUB_CONVERSATION_DEFAULT_MS) => {
      const orch = orchestrationRef.current;
      if (!orch) return;
      const ch = channelRef.current;
      if (!ch) return;

      const subConvId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();

      const sub: SubConversation = {
        id: subConvId,
        initiatorClientId: clientIdRef.current,
        initiatorShortId: shortIdRef.current ?? clientIdRef.current,
        targetClientId,
        topic,
        startedAt: now,
        durationMs,
        status: "active",
      };
      setActiveSubConversation(sub);

      // Broadcast to target
      const payload: SubConversationStartPayload = {
        orchestrationId: orch.id,
        senderId: clientIdRef.current,
        senderShortId: shortIdRef.current ?? clientIdRef.current,
        conversationId: orch.conversationId,
        subConversationId: subConvId,
        initiatorClientId: clientIdRef.current,
        initiatorShortId: shortIdRef.current ?? clientIdRef.current,
        targetClientId,
        topic,
        durationMs,
      };
      ch.send({ type: "broadcast", event: "sub_conversation_start", payload });

      // Auto-end after duration
      subConvTimeoutRef.current = setTimeout(() => {
        setActiveSubConversation((prev) => prev?.id === subConvId ? { ...prev, status: "timeout" } : prev);
        const endPayload: SubConversationEndPayload = {
          orchestrationId: orch.id,
          senderId: clientIdRef.current,
          senderShortId: shortIdRef.current ?? clientIdRef.current,
          conversationId: orch.conversationId,
          subConversationId: subConvId,
          reason: "timeout",
        };
        ch.send({ type: "broadcast", event: "sub_conversation_end", payload: endPayload });
        setTimeout(() => setActiveSubConversation(null), 2000);
      }, durationMs);
    },
    [channelRef],
  );

  const endSubConversation = useCallback(
    (reason: "completed" | "cancelled" = "completed") => {
      const sub = activeSubConversation;
      if (!sub) return;
      const orch = orchestrationRef.current;
      if (!orch) return;
      const ch = channelRef.current;
      if (!ch) return;

      if (subConvTimeoutRef.current) { clearTimeout(subConvTimeoutRef.current); subConvTimeoutRef.current = null; }

      setActiveSubConversation({ ...sub, status: reason === "completed" ? "completed" : "timeout" });
      const payload: SubConversationEndPayload = {
        orchestrationId: orch.id,
        senderId: clientIdRef.current,
        senderShortId: shortIdRef.current ?? clientIdRef.current,
        conversationId: orch.conversationId,
        subConversationId: sub.id,
        reason,
      };
      ch.send({ type: "broadcast", event: "sub_conversation_end", payload });
      setTimeout(() => setActiveSubConversation(null), 1000);
    },
    [activeSubConversation, channelRef],
  );

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------

  return {
    // State
    role,
    orchestration,
    collaborators,
    pendingInvites,
    settings,
    timerRemainingMs,
    startedAt,
    activeSubConversation,

    // Orchestrator actions
    becomeOrchestrator,
    inviteCollaborator,
    sendAgentRequest,
    completeOrchestration,

    // Collaborator actions
    acceptInvite,
    declineInvite,
    sendAgentResponse,

    // Sub-conversation actions
    startSubConversation,
    endSubConversation,

    // Shared actions
    sendAgentMessage,
    markCollaboratorDone,
    updateSettings,
    releaseRole,

    // External event callback refs
    onAgentRequest,
    onAgentResponse,
    onAgentMessage,
    onCollaboratorReady,

    // Orchestration callbacks ref for useFigmaExecuteChannel integration
    orchestrationCallbacksRef,
  };
}
