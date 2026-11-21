CREATE TABLE openworld_server_profiles (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id) ON DELETE CASCADE,
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size integer NOT NULL CHECK (size > 0)
);
