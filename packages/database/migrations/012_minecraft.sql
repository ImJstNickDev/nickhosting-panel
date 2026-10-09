-- Owner availability does not establish verification. No users, runtime mappings,
-- releases, test evidence or instance settings are seeded by this migration.
CREATE TABLE minecraft_combinations (
  id uuid PRIMARY KEY,
  mapping_id uuid NOT NULL REFERENCES runtime_egg_mappings(id),
  identity_digest text NOT NULL CHECK (identity_digest ~ '^[a-f0-9]{64}$'),
  combination jsonb NOT NULL,
  resolved_runtime jsonb NOT NULL,
  binding jsonb NOT NULL,
  mapping_digest text NOT NULL CHECK (mapping_digest ~ '^[a-f0-9]{64}$'),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mapping_id, identity_digest)
);
CREATE TABLE minecraft_verification_evidence (
  id uuid PRIMARY KEY,
  combination_id uuid NOT NULL REFERENCES minecraft_combinations(id),
  report jsonb NOT NULL,
  signature text NOT NULL CHECK (signature ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE minecraft_server_profiles (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id),
  combination_id uuid NOT NULL REFERENCES minecraft_combinations(id),
  configuration jsonb NOT NULL,
  installed boolean NOT NULL DEFAULT false,
  installed_manifest jsonb NOT NULL DEFAULT '[]',
  content_state jsonb NOT NULL DEFAULT '{}',
  configuration_state jsonb NOT NULL DEFAULT '{"status":"pending"}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE minecraft_content_items (
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  path text NOT NULL,
  artifact jsonb NOT NULL,
  installed_by uuid NOT NULL REFERENCES operation_jobs(id),
  installed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, path)
);
ALTER TABLE server_operations DROP CONSTRAINT server_operations_action_check;
ALTER TABLE server_operations ADD CONSTRAINT server_operations_action_check
  CHECK (action IN ('provision','start','stop','restart','reinstall','wipe','delete','backup','restore','configure','minecraft-content'));
