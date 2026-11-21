CREATE SEQUENCE openworld_catalog_sync_order AS bigint;

CREATE TABLE openworld_release_catalog (
  runtime text PRIMARY KEY CHECK (runtime = 'dedicated-linux-x64'),
  credential_hash text NOT NULL CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
  source text NOT NULL CHECK (source IN ('metiva', 'official')),
  releases jsonb NOT NULL CHECK (
    jsonb_typeof(releases) = 'array' AND jsonb_array_length(releases) > 0
  ),
  sync_order bigint NOT NULL,
  synced_at timestamptz NOT NULL
);
