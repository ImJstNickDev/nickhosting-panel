SET LOCAL lock_timeout = '2s';

-- Only digests of the single-use browser code and of the host-scoped session are stored.
-- Ending a panel session immediately removes both outstanding codes and dashboard sessions.
CREATE TABLE openworld_dashboard_sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  parent_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  challenge text CHECK (length(challenge) = 64),
  expires_at timestamptz NOT NULL
);
CREATE INDEX openworld_dashboard_sessions_parent ON openworld_dashboard_sessions(parent_id);
CREATE INDEX openworld_dashboard_sessions_expiry ON openworld_dashboard_sessions(expires_at);
