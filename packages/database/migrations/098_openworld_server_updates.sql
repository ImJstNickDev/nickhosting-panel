SET LOCAL lock_timeout = '2s';

ALTER TABLE openworld_server_profiles ADD COLUMN history_sha256 text
  CHECK (history_sha256 ~ '^[0-9a-f]{64}$');

CREATE TABLE openworld_server_updates (
  job_id uuid PRIMARY KEY REFERENCES server_operations(job_id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('preparing','waiting-empty','notice','stopping','backup','installing','verifying','starting','completed','failed','cancelled')),
  deadline timestamptz,
  restart boolean,
  warning text CHECK (warning IN ('notice_failed','reminder_failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX openworld_updates_by_server ON openworld_server_updates(server_id, created_at DESC, job_id DESC);

CREATE TABLE openworld_update_artifacts (
  job_id uuid PRIMARY KEY REFERENCES openworld_server_updates(job_id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  archive bytea NOT NULL CHECK (octet_length(archive) BETWEEN 1 AND 134217728)
);
CREATE TABLE openworld_update_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  notice_seconds integer NOT NULL CHECK (notice_seconds BETWEEN 1 AND 86400)
);
CREATE TABLE openworld_gateway_release_checks (
  version text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('passed','failed')),
  reason text NOT NULL CHECK (reason IN ('verified','version_mismatch','protocol_mismatch')),
  checked_at timestamptz NOT NULL,
  PRIMARY KEY(version,sha256)
);
