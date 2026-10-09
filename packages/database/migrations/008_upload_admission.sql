-- Uploads remain disabled until the Owner verifies Wings' per-file limit and
-- the actual multipart staging filesystem. No instance values are seeded.
ALTER TABLE physical_hosts ADD COLUMN upload_policy jsonb;
ALTER TABLE physical_hosts ADD CONSTRAINT upload_policy_object
  CHECK (upload_policy IS NULL OR jsonb_typeof(upload_policy) = 'object');

-- One durable ingestion claim per physical host, shared by all of its nodes.
-- Interrupted/ambiguous uploads retain this row until audited Owner recovery.
CREATE TABLE upload_ingestion_claims (
  id uuid PRIMARY KEY,
  physical_host_id uuid NOT NULL UNIQUE REFERENCES physical_hosts(id),
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  actor_user_id text NOT NULL REFERENCES "user"(id),
  declared_bytes bigint NOT NULL CHECK (declared_bytes >= 0 AND declared_bytes <= 9007199254740991),
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes > 0 AND reserved_bytes <= 9007199254740991),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  scope_hash text NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_ingestion_server ON upload_ingestion_claims(server_id);
