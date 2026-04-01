# Beta Access Control — Invite-Only System

## Overview

Guardian uses an invite-only system for private beta access. Public signup is disabled — new users can only join when an admin sends them an invitation email with a unique magic link.

## Local vs Production Differences

| Aspect | Local (Docker) | Production (Supabase hosted) |
|--------|---------------|------------------------------|
| **Auth flow (valid link)** | Implicit (token in URL hash → login page) | PKCE (code in query → `/auth/callback` server-side) |
| **Auth flow (expired link)** | Hash error → login page (client-side) | Hash error → `/auth/callback` (no code) → redirect to login → same client-side handling |
| **Signup disabled** | `config.toml`: `[auth] enable_signup = false` | Dashboard > Authentication > Settings |
| **Email delivery** | Mailpit (`127.0.0.1:54324`) — captured locally | Supabase built-in sender (3/hour free plan) |
| **Email template** | `supabase/templates/invite.html` via `config.toml` | Paste into Dashboard > Email Templates > Invite |
| **Admin account** | Auto-created by `supabase/seed.sql` | Created manually in Dashboard |
| **Database** | Docker containers (volumes persist across restarts) | Hosted Supabase project |
| **Expired link UX** | Identical | Identical |

Despite different auth mechanisms, the **user experience is identical** in both environments.

## Invite Flow

### Happy path

```
Admin (/admin/invite)
  │
  ├─ POST /api/admin/invite
  │   ├─ Supabase auth.admin.inviteUserByEmail()
  │   │   └─ Sends magic link email to invitee
  │   └─ Records invite in beta_invites table (status: pending)
  │
Invitee clicks email link
  │
  ├─ [PROD] Supabase verifies token → redirects to /auth/callback?code=xxx
  │   └─ Server exchanges code for session → redirects to /signup/complete
  │
  ├─ [LOCAL] Supabase verifies token → redirects to site_url#access_token=xxx&type=invite
  │   └─ Login page detects hash → calls setSession() → redirects to /signup/complete
  │
  ├─ /signup/complete
  │   ├─ User fills: first name, last name, work role
  │   ├─ Sets password (min 8 chars)
  │   ├─ Accepts CGU v1.0 (Terms & Conditions)
  │   └─ POST /api/signup/complete
  │       ├─ Updates user metadata (profile_completed: true)
  │       ├─ Records CGU acceptance (IP, user-agent, timestamp, version)
  │       └─ Marks invite as accepted in beta_invites
  │
  └─ User redirected to / — full platform access
```

### Expired link (identical in local and prod)

Supabase always returns errors in the URL hash fragment (`#error=...`), never in query params.
The hash is not sent to the server, so expired link handling is **always client-side** in the login page.

```
Invitee clicks expired/used link
  │
  ├─ Supabase redirects to /auth/callback#error=access_denied&error_description=...
  │   └─ Server sees no ?code= → redirects to /login (browser preserves hash)
  │
  ├─ Login page detects #error in hash
  │   ├─ Tries to decode email from JWT payload (unsigned, works if access_token present)
  │   ├─ If email found → checks beta_invites via /api/signup/check-invite
  │   └─ If no email → shows email input form
  │
  ├─ Account already completed → "Your account is already set up" + Sign in button
  │
  └─ Account not completed → "Request a new invitation" button
      └─ POST /api/signup/request-reinvite
          ├─ Deletes existing auth.users entry
          ├─ Re-invites via inviteUserByEmail() (new magic link)
          └─ Updates beta_invites (status: pending)
```

## Middleware Guards (proxy.ts)

1. **Unauthenticated** → redirect to `/login`
2. **Authenticated, profile not completed** → redirect to `/signup/complete`
3. **Profile completed, on `/signup/complete`** → redirect to `/` (prevent re-access)
4. **Admin pages (`/admin/*`)** → `user_metadata.is_admin` must be `true`, else redirect to `/`
5. **Authenticated + profile completed** → full access

## Pages & API Routes

### Pages

| Path | Access | Description |
|------|--------|-------------|
| `/login` | Public | Login + invite token/error handling |
| `/signup` | Public | "Invite-only" message (no form) |
| `/signup/complete` | Auth required, profile not completed | Profile form + CGU + password |
| `/admin/invite` | Auth required, is_admin | Send invites + list invites |
| `/auth/callback` | Public | PKCE code exchange (prod) |
| `/privacy` | Public | Privacy Policy (GDPR) |

### API Routes

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/admin/invite` | Admin | Send invite email |
| `GET /api/admin/invites` | Admin | List all invites |
| `POST /api/signup/complete` | User | Complete profile + CGU acceptance |
| `POST /api/signup/request-reinvite` | Public | Re-send expired invite (deletes + recreates user) |
| `POST /api/signup/check-invite` | Public | Check invite status by email |

## Database Tables

### beta_invites

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| email | text | Invited email (unique) |
| invited_by | uuid | Admin user ID (FK auth.users) |
| status | text | pending / accepted / expired / revoked |
| invited_at | timestamptz | When the invite was sent |
| accepted_at | timestamptz | When the user completed signup |

RLS: Only `service_role` can access (no anon/authenticated).

### cgu_acceptances

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK auth.users (cascade delete) |
| version | text | CGU version (e.g. "1.0") |
| accepted_at | timestamptz | When accepted |
| ip_address | text | Client IP at acceptance time |
| user_agent | text | Browser user-agent string |

RLS: Authenticated users can read their own. Only `service_role` can insert.

## Admin Access

Admin status is stored in Supabase `user_metadata.is_admin` (boolean). Checked at both middleware level (page access) and API level (route handlers).

### Local development

The `supabase/seed.sql` file creates a default admin account when running `supabase start`:
- **Email:** `admin@guardian.local`
- **Password:** `admin`
- **Metadata:** `{ is_admin: true, profile_completed: true }`

### Production

Create the admin account manually in Supabase Dashboard:
1. Go to **Authentication > Users > Add user**
2. Enter email and password, check **Auto Confirm**
3. Click the user row, then **Edit user** (pencil icon)
4. In **User Metadata**, add: `{"is_admin": true, "profile_completed": true}`
5. Save

## Email Template

The invite email template is at `supabase/templates/invite.html` (single source of truth). It is used by Supabase local via `config.toml`. For production, paste its content into **Supabase Dashboard > Email Templates > Invite User**.

The template uses the Guardian logo served from `/guardian-logo.svg` (via `{{ .SiteURL }}`), dark theme matching the app design, and `{{ .ConfirmationURL }}` for the magic link.

## Production Setup Checklist

1. **Disable public signup**: Dashboard > Authentication > Settings > uncheck "Allow new users to sign up"
2. **Create admin account**: Dashboard > Authentication > Users > Add user (see above)
3. **Paste email template**: Dashboard > Authentication > Email Templates > Invite User
4. **Add redirect URL**: Dashboard > Authentication > URL Configuration > add `https://your-domain.com/auth/callback` to Redirect URLs
5. **Set env vars**: `NEXT_PUBLIC_BASE_URL` must match your production domain (used for invite redirect URLs)

## Supabase Local Commands

```bash
pnpm dev:supabase          # Start (Docker, runs in background)
pnpm dev:supabase:stop     # Stop (data preserved in Docker volumes)
pnpm dev:supabase:clean    # Stop + wipe all data
pnpm dev:supabase:reset    # Stop + wipe + restart fresh (re-applies migrations + seed)
```

`pnpm dev` automatically checks if Supabase local is running and offers to start it.

Emails are captured in **Mailpit**: `http://127.0.0.1:54324`

## Security Notes

- **Invite links are single-use** — once clicked, the token is consumed (even if profile not completed)
- **CGU acceptance** records IP address, user-agent, timestamp, and version for audit compliance
- **Re-invite** deletes and recreates the auth user — only works for non-completed profiles
- **No email enumeration** — public endpoints (`check-invite`, `request-reinvite`) return neutral responses for unknown emails
- **`beta_invites` table** is only accessible via `service_role` (no anon/authenticated access)
- **Signup disabled at Supabase level** — even direct API calls to `auth.signUp()` are rejected
