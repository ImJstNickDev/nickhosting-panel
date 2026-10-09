-- Registry and physical resources belong to NickHosting. No existing server is imported.
CREATE TABLE physical_hosts (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  memory_limit_mib integer NOT NULL CHECK (memory_limit_mib > 0),
  cpu_limit_percent integer NOT NULL CHECK (cpu_limit_percent > 0),
  storage_pool_mib bigint NOT NULL CHECK (storage_pool_mib > 0),
  memory_headroom_mib integer NOT NULL CHECK (memory_headroom_mib >= 0),
  cpu_headroom_percent integer NOT NULL CHECK (cpu_headroom_percent >= 0),
  disk_headroom_mib bigint NOT NULL CHECK (disk_headroom_mib >= 0),
  local_disk_path text NOT NULL,
  observer_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE managed_nodes (
  id uuid PRIMARY KEY,
  physical_host_id uuid NOT NULL REFERENCES physical_hosts(id),
  pterodactyl_node_id integer NOT NULL UNIQUE CHECK (pterodactyl_node_id > 0),
  provision_user_id integer NOT NULL CHECK (provision_user_id > 0),
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE runtime_egg_mappings (
  id uuid PRIMARY KEY,
  game_id text NOT NULL REFERENCES game_integrations(id),
  runtime_id text NOT NULL,
  node_id uuid NOT NULL REFERENCES managed_nodes(id),
  nest_id integer NOT NULL CHECK (nest_id > 0),
  egg_id integer NOT NULL CHECK (egg_id > 0),
  docker_image text NOT NULL,
  startup text NOT NULL,
  environment jsonb NOT NULL CHECK (jsonb_typeof(environment) = 'object'),
  port_roles jsonb NOT NULL CHECK (jsonb_typeof(port_roles) = 'array'),
  feature_limits jsonb NOT NULL CHECK (jsonb_typeof(feature_limits) = 'object'),
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE(game_id, runtime_id, node_id)
);
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id),
  role text NOT NULL CHECK(role IN ('manager','operator','viewer')),
  PRIMARY KEY(project_id,user_id)
);
CREATE TABLE managed_servers (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id),
  project_id uuid REFERENCES projects(id),
  mapping_id uuid NOT NULL REFERENCES runtime_egg_mappings(id),
  node_id uuid NOT NULL REFERENCES managed_nodes(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  external_id text NOT NULL UNIQUE,
  pterodactyl_id integer UNIQUE,
  pterodactyl_uuid uuid UNIQUE,
  pterodactyl_identifier text UNIQUE,
  limits jsonb NOT NULL CHECK(jsonb_typeof(limits)='object'),
  runtime_state text NOT NULL DEFAULT 'unknown' CHECK(runtime_state IN ('offline','starting','running','stopping','unknown')),
  readiness text NOT NULL DEFAULT 'unknown' CHECK(readiness IN ('unknown','loading','ready','degraded')),
  intent text NOT NULL DEFAULT 'manually_stopped' CHECK(intent IN ('manually_stopped','maintenance','auto_wake_enabled','sleeping')),
  installation_state text NOT NULL DEFAULT 'pending' CHECK(installation_state IN ('pending','installing','installed','failed')),
  active_operation_id uuid,
  last_observed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((pterodactyl_id IS NULL) = (pterodactyl_uuid IS NULL)),
  CHECK ((pterodactyl_id IS NULL) = (pterodactyl_identifier IS NULL))
);
CREATE TABLE server_allocations (
  id uuid PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  node_id uuid NOT NULL REFERENCES managed_nodes(id),
  pterodactyl_allocation_id integer NOT NULL CHECK(pterodactyl_allocation_id>0),
  address text NOT NULL,
  port integer NOT NULL CHECK(port BETWEEN 1 AND 65535),
  role text NOT NULL,
  protocols text[] NOT NULL CHECK(protocols <@ ARRAY['tcp','udp']::text[] AND cardinality(protocols)>0),
  is_primary boolean NOT NULL,
  UNIQUE(node_id,pterodactyl_allocation_id),
  UNIQUE(node_id,address,port),
  UNIQUE(server_id,role)
);
CREATE UNIQUE INDEX server_primary_allocation ON server_allocations(server_id) WHERE is_primary;
CREATE TABLE resource_reservations (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id),
  owner_id text NOT NULL REFERENCES "user"(id),
  physical_host_id uuid NOT NULL REFERENCES physical_hosts(id),
  memory_mib integer NOT NULL CHECK(memory_mib>0),
  cpu_percent integer NOT NULL CHECK(cpu_percent>0),
  operation_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('starting','running','restarting','stopping','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_host ON resource_reservations(physical_host_id);
CREATE INDEX reservation_owner ON resource_reservations(owner_id);
CREATE TABLE resource_user_limits (
  user_id text PRIMARY KEY REFERENCES "user"(id),
  memory_mib integer NOT NULL CHECK(memory_mib>0),
  cpu_percent integer NOT NULL CHECK(cpu_percent>0),
  storage_mib bigint NOT NULL CHECK(storage_mib>0),
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE host_observations (
  host_id uuid PRIMARY KEY REFERENCES physical_hosts(id),
  observer_id text NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  observed_at timestamptz NOT NULL
);
CREATE TABLE server_operations (
  job_id uuid PRIMARY KEY REFERENCES operation_jobs(id),
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  action text NOT NULL CHECK(action IN ('provision','start','stop','restart','reinstall','wipe','delete','backup','restore','configure')),
  phase text NOT NULL DEFAULT 'planned',
  plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
  effect_state text NOT NULL DEFAULT 'none' CHECK(effect_state IN ('none','prepared','uncertain','confirmed')),
  effect_started_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE server_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  job_id uuid REFERENCES operation_jobs(id),
  actor_id text REFERENCES "user"(id),
  subject_id text REFERENCES "user"(id),
  support_session_id text,
  message_key text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX server_events_history ON server_events(server_id,id DESC);
CREATE TABLE server_metrics (
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  observed_at timestamptz NOT NULL,
  memory_bytes bigint NOT NULL CHECK(memory_bytes>=0),
  cpu_percent double precision NOT NULL CHECK(cpu_percent>=0),
  disk_bytes bigint NOT NULL CHECK(disk_bytes>=0),
  network_rx_bytes bigint NOT NULL CHECK(network_rx_bytes>=0),
  network_tx_bytes bigint NOT NULL CHECK(network_tx_bytes>=0),
  PRIMARY KEY(server_id,observed_at)
);
CREATE TABLE test_asset_provenance (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id),
  run_id text NOT NULL,
  pr_number integer NOT NULL,
  external_id text NOT NULL UNIQUE,
  pterodactyl_id integer NOT NULL UNIQUE,
  pterodactyl_uuid uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE external_sftp_credentials (
  id uuid PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  actor_id text NOT NULL REFERENCES "user"(id),
  envelope jsonb NOT NULL,
  provider_ref jsonb,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','active','revoking','revoked','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dns_assignments (
  id uuid PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  hostname text NOT NULL UNIQUE,
  ownership_token text NOT NULL UNIQUE,
  plan jsonb NOT NULL,
  ledger jsonb NOT NULL DEFAULT '[]',
  state text NOT NULL CHECK(state IN ('pending','active','deleting','deleted','uncertain')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
