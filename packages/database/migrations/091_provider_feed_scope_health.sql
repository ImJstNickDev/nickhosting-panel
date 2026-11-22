ALTER TABLE provider_server_projections ADD COLUMN scope_healthy_at timestamptz,
  ADD COLUMN scope_owner_id text,
  ADD COLUMN scope_provider_user_id integer,
  ADD COLUMN scope_credential text;

CREATE TABLE provider_feed_link_retries (
  instance_id uuid NOT NULL REFERENCES provider_change_feeds(instance_id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
  binding text NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  retry_at timestamptz NOT NULL,
  PRIMARY KEY (instance_id, server_id)
);
