# Beta Access Control — Invite-Only System

## Overview

Guardian uses an invite-only system for private beta access. Public signup is disabled — new users can only join when an admin sends them an invitation email with a unique magic link.

## Flow

```
Admin (/admin/invite)
  │
  ├─ POST /api/admin/invite
  │   ├─ Supabase auth.admin.inviteUserByEmail()
  │   │   └─ Sends magic link email to invitee
  │   └─ Records invite in beta_invites table
  │
Invitee clicks email link
  │
  ├─ Supabase verifies token
  │   └─ Redirects to /auth/callback?code=xxx
  │
  ├─ GET /auth/callback
  │   ├─ Exchanges code for session
  │   └─ Redirects to /signup/complete
  │
  ├─ /signup/complete
  │   ├─ User fills: first name, last name, work role
  │   ├─ Sets password
  │   ├─ Accepts CGU (Terms & Conditions)
  │   └─ POST /api/signup/complete
  │       ├─ Updates user metadata (profile_completed: true)
  │       ├─ Records CGU acceptance (IP, user-agent, timestamp)
  │       └─ Marks invite as accepted
  │
  └─ User redirected to / — full platform access
```

## Middleware Guards (proxy.ts)

1. **Unauthenticated** → redirect to `/login`
2. **Authenticated, profile not completed** → redirect to `/signup/complete`
3. **Admin pages (`/admin/*`)** → `user_metadata.is_admin` must be `true`
4. **Authenticated + profile completed** → full access

## Database Tables

### beta_invites
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| email | text | Invited email (unique) |
| invited_by | uuid | Admin user ID |
| status | text | pending / accepted / expired / revoked |
| invited_at | timestamptz | When the invite was sent |
| accepted_at | timestamptz | When the user completed signup |

### cgu_acceptances
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | References auth.users |
| version | text | CGU version (e.g. "1.0") |
| accepted_at | timestamptz | When accepted |
| ip_address | text | Client IP at acceptance time |
| user_agent | text | Browser user-agent string |

## Admin Access

Admin status is stored in Supabase `user_metadata.is_admin` (boolean).

### Local development

The `supabase/seed.sql` file creates a default admin account when running `supabase start`:
- **Email:** `admin@guardian.local`
- **Password:** `admin`

### Production

Create the admin account manually in Supabase Dashboard:
1. Go to **Authentication > Users > Add user**
2. Enter email and password, check **Auto Confirm**
3. Click the user row, then **Edit user** (pencil icon)
4. In **User Metadata**, add: `{"is_admin": true, "profile_completed": true}`
5. Save

## Email Template

A custom HTML email template is provided at `packages/web/src/app/admin/invite/email-template.html`. Paste it into **Supabase Dashboard > Authentication > Email Templates > Invite User**.

## Security Notes

- CGU acceptance records IP address and user-agent for audit compliance
- Admin check is done both at middleware level (page access) and API level (route handlers)
- Invite emails use Supabase's built-in mail sender (rate-limited to 3/hour on free plan)
- `beta_invites` table is only accessible via `service_role` (no anon/authenticated access)
