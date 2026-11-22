SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

-- A bounded heartbeat selects the oldest eligible links first. The token
-- prevents a superseded in-flight result from overwriting a newer observation.
CREATE TABLE gateway_feed_heartbeat (
  server_id uuid PRIMARY KEY REFERENCES provider_server_projections(server_id) ON DELETE CASCADE,
  token uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  checked_at timestamptz
);
