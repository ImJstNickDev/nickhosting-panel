-- Generic automation retains author identity; it never stores interactive sessions.
CREATE TABLE server_schedules (
  id uuid PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES managed_servers(id),
  creator_id text NOT NULL REFERENCES "user"(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  action text NOT NULL CHECK (action IN ('start', 'stop', 'restart', 'backup')),
  timing jsonb NOT NULL CHECK (jsonb_typeof(timing) = 'object'),
  time_zone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  next_run_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX server_schedules_due ON server_schedules(next_run_at)
  WHERE enabled AND deleted_at IS NULL;
CREATE INDEX server_schedules_server ON server_schedules(server_id, created_at);

-- Advancement, outcome and lifecycle job/outbox insertion share one transaction.
-- Unique revision/due identities prevent worker crash/restart or duplicate polls
-- from repeating an occurrence. Deleted schedules retain their outcome history.
CREATE TABLE schedule_occurrences (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES server_schedules(id),
  revision integer NOT NULL,
  due_at timestamptz NOT NULL,
  action text NOT NULL CHECK (action IN ('start', 'stop', 'restart', 'backup')),
  status text NOT NULL CHECK (status IN ('dispatched', 'skipped')),
  reason text,
  missed_count integer NOT NULL DEFAULT 0 CHECK (missed_count >= 0),
  job_id uuid UNIQUE REFERENCES operation_jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, revision, due_at),
  CHECK ((status = 'dispatched') = (job_id IS NOT NULL)),
  CHECK ((status = 'skipped') = (reason IS NOT NULL))
);
CREATE INDEX schedule_occurrences_history ON schedule_occurrences(schedule_id, due_at DESC, id DESC);
