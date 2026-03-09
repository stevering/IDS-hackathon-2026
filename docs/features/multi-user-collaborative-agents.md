# Multi-User Collaborative Agents — Feature Specification

> **Status**: Future feature — architecture designed for extensibility, not yet implemented.
> **Prerequisite**: Single-user Collaborative Agents mode (MVP).

## Overview

The Collaborative Agents MVP supports a single user account with multiple browser windows/plugins. This document describes the extension to **cross-user collaboration**, where User A's orchestrator agent can delegate tasks to User B's plugin agents.

## Current Architecture (Single-User)

| Component | Scope |
|-----------|-------|
| Supabase RT channel | `guardian:execute:{userId}` — user-scoped |
| Client registry | `user_clients` table — `user_id` FK to `auth.users` |
| Orchestrations | `orchestrations` table — `user_id` FK, single owner |
| Conversations | `conversations` table — `user_id` FK, RLS per user |
| Messages | `messages` table — RLS via conversation ownership |

All communication happens within a single user's channel. Cross-user clients cannot see each other's presence, conversations, or orchestrations.

## What Needs to Change

### 1. Shared Orchestration Channel

**Current**: All events (execute, orchestration, agent messages) on `guardian:execute:{userId}`.

**Proposed**: When an orchestration involves multiple users, create a shared channel:
```
guardian:orchestration:{orchestrationId}
```

- The user-scoped channel remains for single-user operations and presence discovery.
- The orchestration channel is joined by ALL participants (any user) when they accept an invitation.
- Both channels coexist; the client subscribes to both simultaneously.

### 2. Database Schema Changes

#### `orchestrations` table

```sql
-- Add participants tracking
ALTER TABLE public.orchestrations
  ADD COLUMN participants UUID[] DEFAULT '{}';
  -- Array of user_ids involved in this orchestration

-- Or use a junction table for more flexibility:
CREATE TABLE public.orchestration_participants (
  orchestration_id UUID NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id        TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('orchestrator', 'collaborator')),
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (orchestration_id, user_id, client_id)
);
```

#### RLS Policy Changes

```sql
-- Users can see orchestrations they participate in
CREATE POLICY "users see participated orchestrations"
  ON public.orchestrations FOR SELECT
  USING (
    auth.uid() = user_id  -- owner
    OR auth.uid() = ANY(participants)  -- participant
  );

-- Messages in cross-user conversations accessible via orchestration_participants
CREATE POLICY "cross-user message access"
  ON public.messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      JOIN orchestration_participants op ON op.orchestration_id = c.orchestration_id
      WHERE c.id = conversation_id AND op.user_id = auth.uid()
    )
  );
```

#### Conversations

```sql
-- Add shared access tracking
ALTER TABLE public.conversations
  ADD COLUMN shared_with UUID[] DEFAULT '{}';
  -- User IDs that can access this conversation
```

### 3. Cross-User Discovery and Invitation

#### Option A: Collaboration Link (Recommended for MVP)
- User B generates a **collaboration link** or **invite code** from their Guardian dashboard.
- User A enters the code to discover User B's available agents.
- The link encodes: User B's ID + a one-time token (stored in a `collaboration_invites` table).

#### Option B: Team/Workspace Model (Future)
- Users belong to a shared workspace.
- All workspace members' agents are discoverable.
- Requires new tables: `workspaces`, `workspace_members`.

#### Option C: Email/Identifier Lookup
- User A enters User B's email.
- System sends an invitation notification.
- Requires email notification infrastructure.

### 4. Security Constraints

| Rule | Rationale |
|------|-----------|
| **No cross-user Direct Control** | User A must NEVER `eval()` code on User B's plugin. Only natural language requests (Collaborative Agents mode). |
| **First cross-user invite requires explicit consent** | Even with auto-accept ON for same-user, first cross-user invite must be explicitly approved. |
| **Rate limiting** | Max 10 cross-user invitations per hour per user. |
| **Block list** | Users can block specific users from sending invitations. |
| **Audit log** | All cross-user orchestrations logged with: who, when, what task, duration. |

### 5. Cost and API Key Implications

Each user uses their own API keys and quota:

| Participant | Pays for |
|-------------|----------|
| Orchestrator's user | Orchestrator's LLM calls (task decomposition, verification) |
| Collaborator's user | Collaborator's LLM calls (autonomous task execution) |

The orchestration invite modal should clearly show:
- "This task will use YOUR API key for AI processing"
- Estimated token usage (if possible)

### 6. Presence and Privacy

#### Cross-User Presence
- By default, users are **invisible** to other users.
- Users opt-in to a **"collaboration space"** (via settings or invite code).
- Only agents that are explicitly shared are visible.

#### Privacy Controls
```
user_settings:
  collaboration_visibility: 'private' | 'link-only' | 'workspace'
  share_file_names: boolean  (default: false)
  share_selection: boolean   (default: false)
```

### 7. Implementation Phases

#### Phase A: Shared Channel Infrastructure
- New `orchestration_participants` table
- Shared channel `guardian:orchestration:{orchestrationId}`
- Dual-channel subscription in `useFigmaExecuteChannel`

#### Phase B: Cross-User Invitation
- `collaboration_invites` table (one-time codes)
- Invitation UI (generate/enter code)
- First-time consent flow

#### Phase C: Privacy and Security
- Block list
- Audit logging
- Rate limiting
- Visibility settings

## Open Questions

1. **Team model**: Is a workspace/team concept needed, or is peer-to-peer (via invite codes) sufficient?
2. **Conversation ownership**: Should cross-user conversations be visible to both users, or only the orchestrator? If both, how to handle deletion/privacy?
3. **Conflicting instructions**: When User B manually intervenes and contradicts User A's orchestrator, who takes precedence? Proposed: User B (local human) always overrides remote orchestrator.
4. **Token attribution**: In shared orchestrations, should there be a "sponsored" mode where the orchestrator's user pays for all LLM calls? Or always split?
5. **GDPR/privacy**: Cross-user message storage raises data privacy concerns. Each user should be able to delete their side of the conversation. What about the other user's copy?
6. **Offline delivery**: If User B's agent is offline when invited, should the invitation be queued? For how long?
7. **Real-time visibility**: Should the orchestrator see the collaborator's chat in real-time (like screen sharing), or only receive explicit reports?
