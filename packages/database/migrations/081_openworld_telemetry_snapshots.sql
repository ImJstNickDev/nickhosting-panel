CREATE TABLE openworld_telemetry_snapshots (
  server_id uuid NOT NULL REFERENCES openworld_server_profiles(server_id) ON DELETE CASCADE,
  resource text NOT NULL CHECK (resource IN ('status', 'players', 'history', 'chunks', 'storage')),
  binding text NOT NULL,
  observed_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (server_id, resource)
);
