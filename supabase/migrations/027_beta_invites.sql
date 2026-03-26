-- Beta invites & CGU acceptances for private beta access control
-- Migration 027

-- ─── Beta invites ────────────────────────────────────────────────────────────

create table if not exists public.beta_invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  invited_by  uuid references auth.users(id) on delete set null,
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'expired', 'revoked')),
  invited_at  timestamptz not null default now(),
  accepted_at timestamptz,
  unique (email)
);

alter table public.beta_invites enable row level security;

-- Admin can see all invites (admin check done at API level)
create policy "service_role can manage beta_invites"
  on public.beta_invites for all
  using (true)
  with check (true);

-- Revoke default access
revoke all on public.beta_invites from anon, authenticated;
-- Only service_role (used by admin API routes) can access
grant all on public.beta_invites to service_role;

-- ─── CGU acceptances ─────────────────────────────────────────────────────────

create table if not exists public.cgu_acceptances (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  version     text not null default '1.0',
  accepted_at timestamptz not null default now(),
  ip_address  text,
  user_agent  text,
  unique (user_id, version)
);

alter table public.cgu_acceptances enable row level security;

-- Users can read their own acceptances
create policy "users can read own cgu_acceptances"
  on public.cgu_acceptances for select
  using (auth.uid() = user_id);

-- Only service_role can insert (done server-side with IP/UA tracking)
revoke insert, update, delete on public.cgu_acceptances from anon, authenticated;
grant all on public.cgu_acceptances to service_role;
grant select on public.cgu_acceptances to authenticated;
