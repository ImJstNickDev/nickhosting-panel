-- Explicit registrations only. No provider import, network changes or instance seeds.
CREATE TABLE gateway_routes (
  id uuid PRIMARY KEY,
  gateway_id uuid NOT NULL,
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  allocation_id uuid NOT NULL REFERENCES server_allocations(id) ON DELETE CASCADE,
  public_address text NOT NULL,
  public_port integer NOT NULL CHECK(public_port BETWEEN 1 AND 65535),
  transport text NOT NULL CHECK(transport IN ('tcp','udp')),
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  payload_hash text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(gateway_id,public_address,public_port,transport),
  UNIQUE(allocation_id,transport)
);
CREATE TABLE gateway_control_state (
  gateway_id uuid PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  snapshot_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gateway_reachability_proofs (
  route_id uuid PRIMARY KEY REFERENCES gateway_routes(id) ON DELETE CASCADE,
  proof jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
