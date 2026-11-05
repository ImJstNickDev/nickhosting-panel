ALTER TABLE satisfactory_mod_states
  ADD COLUMN revision integer NOT NULL DEFAULT 0,
  ADD COLUMN vanilla boolean NOT NULL DEFAULT false,
  ADD COLUMN active_profile_id uuid,
  ADD COLUMN external_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN external_previous_intent text,
  ADD COLUMN inventory_fingerprint text,
  ADD COLUMN recovery jsonb;

CREATE TABLE satisfactory_mod_profiles (
  id uuid PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  selection jsonb NOT NULL,
  vanilla boolean NOT NULL DEFAULT false,
  required_targets jsonb NOT NULL DEFAULT '["LinuxServer"]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, name)
);
CREATE INDEX satisfactory_mod_profiles_server ON satisfactory_mod_profiles(server_id);
CREATE TABLE satisfactory_mod_plans (
  id uuid PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
  job_id uuid REFERENCES operation_jobs(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','applied','failed')),
  selection jsonb NOT NULL,
  vanilla boolean NOT NULL DEFAULT false,
  profile_id uuid REFERENCES satisfactory_mod_profiles(id) ON DELETE SET NULL,
  lock jsonb,
  files jsonb,
  changes jsonb,
  inventory_fingerprint text,
  game_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX satisfactory_mod_plans_server ON satisfactory_mod_plans(server_id, created_at DESC);
