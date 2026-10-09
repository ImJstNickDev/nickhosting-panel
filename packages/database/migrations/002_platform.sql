CREATE TABLE platform_settings (
  key text PRIMARY KEY CHECK (key = 'platform'),
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE encrypted_secrets (
  name text PRIMARY KEY,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TYPE game_rollout_state AS ENUM ('development', 'private-testing', 'public', 'disabled-for-new-servers');
CREATE TABLE game_integrations (
  id text PRIMARY KEY,
  version text NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE game_rollouts (
  integration_id text PRIMARY KEY REFERENCES game_integrations(id),
  state game_rollout_state NOT NULL,
  allowlist text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
