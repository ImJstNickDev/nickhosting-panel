-- Diagnostic progress only: no credentials, addresses, exception strings or
-- provider payloads. A heartbeat does not replace job/route readiness evidence.
CREATE TABLE service_heartbeats (
  service text NOT NULL CHECK (service IN ('worker', 'gateway')),
  instance_id uuid NOT NULL,
  scope_hash text NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('running', 'degraded', 'stopped', 'contact')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (service, instance_id),
  CHECK ((service = 'gateway') = (state = 'contact'))
);
CREATE INDEX service_heartbeats_scope ON service_heartbeats(service, scope_hash, observed_at DESC);
