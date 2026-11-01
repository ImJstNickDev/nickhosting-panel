-- Presentation/discovery metadata only; never changes Owner availability or runtime identity.
CREATE TABLE minecraft_release_metadata (
  id text PRIMARY KEY,
  release_type text NOT NULL CHECK (release_type IN ('release','snapshot','old_alpha','old_beta')),
  release_time timestamptz,
  metadata_url text NOT NULL,
  sha1 text NOT NULL CHECK (sha1 ~ '^[a-fA-F0-9]{40}$')
);
CREATE TABLE minecraft_metadata_sync (
  id text PRIMARY KEY CHECK (id = 'mojang'),
  manifest_json jsonb,
  manifest_hash text,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  lease_id uuid,
  lease_until timestamptz
);
