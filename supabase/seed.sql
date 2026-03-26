-- Seed data for local development (supabase start)
-- Creates a default admin account with a known password.

-- Admin account: admin@guardian.local / admin
INSERT INTO auth.users (
  id, instance_id, aud, role,
  email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_user_meta_data, confirmation_token
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'admin@guardian.local',
  crypt('admin', gen_salt('bf')),
  now(), now(), now(),
  '{"is_admin": true, "profile_completed": true, "first_name": "Admin", "last_name": "Dev"}'::jsonb,
  ''
) ON CONFLICT (id) DO NOTHING;

-- Required identity row for Supabase Auth to work
INSERT INTO auth.identities (
  id, user_id, provider_id, provider,
  identity_data, last_sign_in_at, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'admin@guardian.local', 'email',
  '{"sub": "00000000-0000-0000-0000-000000000001", "email": "admin@guardian.local"}'::jsonb,
  now(), now(), now()
) ON CONFLICT (id, provider) DO NOTHING;
