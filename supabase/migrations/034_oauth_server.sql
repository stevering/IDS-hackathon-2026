-- ═══════════════════════════════════════════════════════════════════════════
-- 034 — OAuth 2.0 Authorization Server (RFC 6749 + RFC 7636 PKCE)
--
-- Exposes Guardian as a full OAuth AS so the Desktop Companion (and future
-- third-party clients) can pair via Authorization Code + PKCE.
--
-- Tables:
--   oauth_clients                — registered OAuth clients (public/confidential)
--   oauth_authorization_codes    — short-lived (120s), single-use auth codes
--   oauth_refresh_tokens         — long-lived, rotated, revocable per device
--
-- All three tables are manipulated exclusively via service-role endpoints
-- (/api/oauth/*). RLS is enabled with a blanket DENY for non-service roles.
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  1. oauth_clients                                                          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.oauth_clients (
  id                  TEXT        PRIMARY KEY,
  name                TEXT        NOT NULL,
  client_type         TEXT        NOT NULL CHECK (client_type IN ('public', 'confidential')),
  client_secret_hash  TEXT,
  redirect_uris       TEXT[]      NOT NULL,
  allowed_scopes      TEXT[]      NOT NULL DEFAULT ARRAY['companion'],
  requires_pkce       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;
-- No policies → all access is blocked except for service_role (which bypasses RLS).

-- Companion redirects:
--   guardian://oauth/callback          — packaged builds (custom scheme)
--   http://127.0.0.1/oauth/callback    — dev (RFC 8252 §7.3 loopback template,
--                                        ANY port accepted at verification time)
INSERT INTO public.oauth_clients (id, name, client_type, redirect_uris, allowed_scopes)
VALUES (
  'guardian_companion',
  'Guardian Desktop Companion',
  'public',
  ARRAY['guardian://oauth/callback', 'http://127.0.0.1/oauth/callback'],
  ARRAY['companion']
)
ON CONFLICT (id) DO UPDATE SET redirect_uris = EXCLUDED.redirect_uris;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  2. oauth_authorization_codes                                              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.oauth_authorization_codes (
  code                   TEXT        PRIMARY KEY,
  client_id              TEXT        NOT NULL REFERENCES public.oauth_clients(id),
  user_id                UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  redirect_uri           TEXT        NOT NULL,
  scope                  TEXT        NOT NULL,
  code_challenge         TEXT        NOT NULL,
  code_challenge_method  TEXT        NOT NULL CHECK (code_challenge_method = 'S256'),
  device_fingerprint     TEXT,
  device_name            TEXT,
  consumed_at            TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expires
  ON public.oauth_authorization_codes (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE public.oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
-- Service-role only.


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  3. oauth_refresh_tokens                                                   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.oauth_refresh_tokens (
  token_hash    TEXT        PRIMARY KEY,
  client_id     TEXT        NOT NULL REFERENCES public.oauth_clients(id),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id     UUID        REFERENCES public.user_devices(id) ON DELETE CASCADE,
  scope         TEXT        NOT NULL,
  revoked_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_user_active
  ON public.oauth_refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_device_active
  ON public.oauth_refresh_tokens (device_id) WHERE revoked_at IS NULL;

ALTER TABLE public.oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
-- Service-role only.


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  4. Grants                                                                  ║
-- ║     Everything is service-role. Revoke from public/authenticated to be     ║
-- ║     explicit (RLS already blocks them, but belt + suspenders).             ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

REVOKE ALL ON public.oauth_clients               FROM PUBLIC, authenticated, anon;
REVOKE ALL ON public.oauth_authorization_codes   FROM PUBLIC, authenticated, anon;
REVOKE ALL ON public.oauth_refresh_tokens        FROM PUBLIC, authenticated, anon;

GRANT ALL ON public.oauth_clients                TO service_role;
GRANT ALL ON public.oauth_authorization_codes    TO service_role;
GRANT ALL ON public.oauth_refresh_tokens         TO service_role;
