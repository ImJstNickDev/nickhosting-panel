-- Existing servers are deliberately not opted in to automatic DNS publication.
CREATE TABLE server_dns_preferences (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id),
  domain_id text,
  subdomain text,
  assignment_id uuid REFERENCES dns_assignments(id),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE shared_dns_hosts (
  id uuid PRIMARY KEY,
  scope_key text NOT NULL UNIQUE,
  hostname text NOT NULL UNIQUE,
  ownership_token uuid NOT NULL UNIQUE,
  plan jsonb NOT NULL,
  ledger jsonb NOT NULL DEFAULT '[]',
  state text NOT NULL CHECK (state IN ('pending','active','uncertain')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dns_hostname_reservations (
  hostname text PRIMARY KEY,
  owner_id uuid NOT NULL,
  release_after timestamptz
);
INSERT INTO dns_hostname_reservations(hostname,owner_id)
SELECT hostname,id FROM dns_assignments WHERE state <> 'deleted';
