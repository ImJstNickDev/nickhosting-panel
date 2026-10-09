-- Installers are transient physical workloads, separate from a user's active game budget.
ALTER TABLE managed_nodes
  ADD COLUMN installer_memory_mib integer NOT NULL DEFAULT 1024 CHECK (installer_memory_mib > 0),
  ADD COLUMN installer_cpu_percent integer NOT NULL DEFAULT 100 CHECK (installer_cpu_percent > 0);

CREATE TABLE installation_reservations (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id),
  physical_host_id uuid NOT NULL REFERENCES physical_hosts(id),
  operation_id uuid NOT NULL REFERENCES operation_jobs(id),
  memory_mib integer NOT NULL CHECK (memory_mib > 0),
  cpu_percent integer NOT NULL CHECK (cpu_percent > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX installation_reservation_host ON installation_reservations(physical_host_id);
