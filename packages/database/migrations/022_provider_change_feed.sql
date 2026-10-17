-- Extension projections are advisory: stale/unhealthy feeds fall back to the provider API.
CREATE TABLE provider_change_feeds (
  instance_id uuid PRIMARY KEY,
  provider_url text NOT NULL UNIQUE,
  callback_url text NOT NULL,
  healthy_at timestamptz,
  generation bigint NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE provider_server_projections (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL REFERENCES provider_change_feeds(instance_id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  synchronized_at timestamptz NOT NULL,
  identity_invalidated boolean NOT NULL DEFAULT false,
  valid boolean NOT NULL DEFAULT true
);
