-- Explicit per-server automation only; no users, routes or instance values are seeded.
CREATE TABLE gateway_server_states (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id),
  generation uuid NOT NULL,
  enabled boolean NOT NULL,
  protocol_id text NOT NULL,
  game_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('sleeping','waking','online','blocked','maintenance','manually_stopped')),
  idle_timeout_seconds integer CHECK (idle_timeout_seconds BETWEEN 1 AND 604800),
  readiness_timeout_seconds integer NOT NULL CHECK (readiness_timeout_seconds BETWEEN 1 AND 86400),
  readiness_max_age_seconds integer NOT NULL CHECK (readiness_max_age_seconds BETWEEN 1 AND 300),
  estimate_max_age_seconds integer NOT NULL CHECK (estimate_max_age_seconds BETWEEN 60 AND 2592000),
  wake_retry_seconds integer NOT NULL CHECK (wake_retry_seconds BETWEEN 1 AND 300),
  wake_job_id uuid REFERENCES operation_jobs(id),
  sleep_job_id uuid REFERENCES operation_jobs(id),
  process_started_at text,
  readiness_observed_at timestamptz,
  startup_deadline_at timestamptz,
  idle_since timestamptz,
  last_observed_at timestamptz,
  last_activity_at timestamptz,
  blocked_until timestamptz,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gateway_startup_samples (
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  job_id uuid PRIMARY KEY REFERENCES operation_jobs(id),
  fingerprint text NOT NULL,
  process_started_at text NOT NULL,
  ready_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 86400000)
);
CREATE INDEX gateway_startup_recent ON gateway_startup_samples(server_id, ready_at DESC);
