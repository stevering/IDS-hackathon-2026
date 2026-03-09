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
  UserCollaborationSettings,
} from "@/types/orchestration";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollaboratorInfo = {
  clientId: string;
  shortId: string;
  label: string;
  status: "invited" | "active" | "completed";
  conversationId?: string;
  task?: string;
};

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
};

export type UseOrchestrationReturn = {
  // State
  role: AgentRole;
  orchestration: Orchestration | null;
  collaborators: CollaboratorInfo[];
  pendingInvites: OrchestrationInvitePayload[];
  settings: UserCollaborationSettings;

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

  // Shared actions
  sendAgentMessage: (
    content: string,
    mentions?: string[],
    insertInActive?: boolean,
  ) => void;
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

  // External event callback refs (page.tsx sets these)
  const onAgentRequest = useRef<((payload: AgentRequestPayload) => void) | null>(null);
  const onAgentResponse = useRef<((payload: AgentResponsePayload) => void) | null>(null);
  const onAgentMessage = useRef<((payload: AgentMessagePayload) => void) | null>(null);
  // Called when a collaborator accepts (orchestrator side) — page.tsx uses this to notify the AI
  const onCollaboratorReady = useRef<((senderId: string, senderShortId: string) => void) | null>(null);

  // Forward ref so onAccept can call sendAgentRequest (defined later)
  const sendAgentRequestRef = useRef<UseOrchestrationReturn["sendAgentRequest"] | null>(null);

  // -------------------------------------------------------------------------
  // Orchestration callbacks ref (consumed by useFigmaExecuteChannel)
  // -------------------------------------------------------------------------
  const orchestrationCallbacksRef = useRef<OrchestrationCallbacks>({});

  // -------------------------------------------------------------------------
  // Accept invite (declared early so onInvite can reference it for autoAccept)
  // -------------------------------------------------------------------------
  const acceptInvite = useCallback(async (orchestrationId: string): Promise<string | null> => {
    try {
      // Find the matching invite to get conversation context
      const invite = pendingInvites.find((inv) => inv.orchestrationId === orchestrationId);

      // Create a sub-conversation for the collaborator
      const convRes = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Collaborative task",
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
        onAgentResponse.current?.(payload);
      },

      onAgentMessage: (payload: AgentMessagePayload) => {
        onAgentMessage.current?.(payload);
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

      // Then schedule state updates for React re-render
      setRole("orchestrator");
      setOrchestration(orch);
      setCollaborators([]);

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

      try {
        await fetch(`/api/orchestrations/${orch.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
      } catch (err) {
        console.warn("[Orchestration] completeOrchestration failed:", err);
      }

      // Reset local state regardless of API outcome
      setRole("idle");
      setOrchestration(null);
      setCollaborators([]);
    },
    [],
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
    (content: string, mentions?: string[], insertInActive?: boolean) => {
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
      };

      ch.send({ type: "broadcast", event: "agent_message", payload });
    },
    [channelRef],
  );

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

    setRole("idle");
    setOrchestration(null);
    setCollaborators([]);
    setPendingInvites([]);
  }, []);

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

    // Orchestrator actions
    becomeOrchestrator,
    inviteCollaborator,
    sendAgentRequest,
    completeOrchestration,

    // Collaborator actions
    acceptInvite,
    declineInvite,
    sendAgentResponse,

    // Shared actions
    sendAgentMessage,
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
