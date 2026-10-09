-- Source preparation is not installation. Incomplete and uncertain transfers
-- retain their reservation until scoped, audited recovery; age never frees it.
CREATE TABLE minecraft_sources (
  id uuid PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES "user"(id),
  owner_user_id text NOT NULL REFERENCES "user"(id),
  server_id uuid REFERENCES managed_servers(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  identity_digest text NOT NULL CHECK (identity_digest ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('world','modpack')),
  origin text NOT NULL CHECK (origin IN ('upload','modrinth')),
  declared_bytes bigint NOT NULL CHECK (declared_bytes > 0 AND declared_bytes <= 9007199254740991),
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= declared_bytes AND reserved_bytes <= 9007199254740991),
  expected_hashes jsonb NOT NULL CHECK (jsonb_typeof(expected_hashes) = 'object'),
  actual_sha256 text CHECK (actual_sha256 ~ '^[a-f0-9]{64}$'),
  storage_root text NOT NULL,
  provider_project_id text,
  provider_version_id text,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','receiving','ready','uncertain','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'ready' OR actual_sha256 IS NOT NULL),
  CHECK ((origin = 'upload' AND provider_project_id IS NULL AND provider_version_id IS NULL)
      OR (origin = 'modrinth' AND kind = 'modpack' AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL)),
  UNIQUE (owner_user_id, idempotency_key)
);
CREATE UNIQUE INDEX minecraft_sources_identity ON minecraft_sources(owner_user_id, identity_digest) WHERE state <> 'released';
CREATE INDEX minecraft_sources_capacity ON minecraft_sources(state, owner_user_id);
CREATE INDEX minecraft_sources_server ON minecraft_sources(server_id);
-- Wizard archives remain immutable and may be explicitly bound to several new
-- servers belonging to that owner. Guessing a reference cannot establish use.
CREATE TABLE minecraft_source_bindings (
  source_id uuid NOT NULL REFERENCES minecraft_sources(id),
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, server_id)
);
-- Expanded job output shares the same authoritative disk budget as archives.
-- A worker crash leaves the claim in place; retries cannot reserve twice.
CREATE TABLE minecraft_staging_claims (
  job_id uuid PRIMARY KEY REFERENCES operation_jobs(id),
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  owner_user_id text NOT NULL REFERENCES "user"(id),
  actor_user_id text NOT NULL REFERENCES "user"(id),
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes > 0 AND reserved_bytes <= 9007199254740991),
  storage_root text NOT NULL,
  identity_digest text NOT NULL CHECK (identity_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','released')),
  created_at timestamptz NOT NULL DEFAULT now()
);
