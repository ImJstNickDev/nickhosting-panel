CREATE TABLE "user" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'operator', 'user')),
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'it')),
  "twoFactorEnabled" boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_platform_owner ON "user" (role) WHERE role = 'owner';
CREATE UNIQUE INDEX identity_email_normalized ON "user" (lower(email));
CREATE TABLE session (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX identity_session_user_idx ON session ("userId");
CREATE TABLE account (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  scope text, password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("providerId", "accountId"), UNIQUE ("userId", "providerId")
);
CREATE TABLE verification (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, identifier text NOT NULL, value text NOT NULL,
  "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier ON verification(identifier);
CREATE TABLE "twoFactor" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, secret text NOT NULL, "backupCodes" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  verified boolean NOT NULL DEFAULT true, "failedVerificationCount" integer NOT NULL DEFAULT 0,
  "lockedUntil" timestamptz
);
CREATE INDEX two_factor_user ON "twoFactor" ("userId");
CREATE TABLE passkey (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, name text, "publicKey" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "credentialID" text NOT NULL UNIQUE, counter bigint NOT NULL,
  "deviceType" text NOT NULL, "backedUp" boolean NOT NULL, transports text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), aaguid text
);
CREATE INDEX passkey_user ON passkey ("userId");
CREATE TABLE "rateLimit" (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, key text NOT NULL UNIQUE, count integer NOT NULL, "lastRequest" bigint NOT NULL);
CREATE TABLE invitation (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "tokenHash" text NOT NULL UNIQUE,
  "remainingUses" integer NOT NULL CHECK ("remainingUses" >= 0),
  "maxUses" integer NOT NULL CHECK ("maxUses" BETWEEN 1 AND 100),
  "expiresAt" timestamptz NOT NULL, "revokedAt" timestamptz,
  email text, role text NOT NULL CHECK (role IN ('operator', 'user')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "createdBy" text NOT NULL REFERENCES "user"(id),
  CHECK ("remainingUses" <= "maxUses")
);
CREATE TABLE instance_setup (
  id integer PRIMARY KEY CHECK (id = 1), owner_user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE step_up_grants (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE support_sessions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, token_hash text NOT NULL UNIQUE,
  actor_user_id text NOT NULL REFERENCES "user"(id), subject_user_id text NOT NULL REFERENCES "user"(id),
  parent_session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  reason text NOT NULL, origin text NOT NULL, audit_correlation_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  CHECK (actor_user_id <> subject_user_id)
);
CREATE TABLE audit_events (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, actor_user_id text REFERENCES "user"(id), subject_user_id text REFERENCES "user"(id),
  action text NOT NULL, correlation_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_actor_time ON audit_events(actor_user_id, created_at);
CREATE TABLE email_credential_claims (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  email text NOT NULL, password_hash text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE identity_throttle (
  key text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL
);
