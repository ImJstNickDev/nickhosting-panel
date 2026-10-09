-- PostgreSQL owns commands, attempts, completion and replay protection. Redis is transport.
CREATE TABLE operation_jobs (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL REFERENCES "user"(id),
  subject_id text NOT NULL REFERENCES "user"(id),
  resource_owner_id text NOT NULL REFERENCES "user"(id),
  support_session_id text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  command_hash text NOT NULL CHECK (length(command_hash) = 64),
  command jsonb NOT NULL CHECK (jsonb_typeof(command) = 'object'),
  policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  error_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (actor_id, idempotency_key),
  CHECK (attempts <= max_attempts),
  CHECK ((state IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)),
  CHECK (actor_id = subject_id OR support_session_id IS NOT NULL)
);
CREATE INDEX operation_jobs_resource_owner ON operation_jobs(resource_owner_id, created_at DESC);

CREATE TABLE job_outbox (
  job_id uuid PRIMARY KEY REFERENCES operation_jobs(id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  next_dispatch_at timestamptz NOT NULL DEFAULT now(),
  last_dispatched_at timestamptz
);
CREATE INDEX job_outbox_due ON job_outbox(next_dispatch_at);

CREATE TABLE job_steps (
  job_id uuid NOT NULL REFERENCES operation_jobs(id) ON DELETE CASCADE,
  step text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, step)
);

CREATE TABLE activity_events (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES operation_jobs(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES "user"(id),
  subject_id text NOT NULL REFERENCES "user"(id),
  resource_owner_id text NOT NULL REFERENCES "user"(id),
  message_key text NOT NULL,
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_events_resource_owner ON activity_events(resource_owner_id, created_at DESC);
