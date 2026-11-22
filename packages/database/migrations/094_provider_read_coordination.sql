SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

-- One poll cadence per installation. The sweep lock is session-scoped and a
-- crashed holder cannot advance the completion watermark.
CREATE TABLE fleet_reconciliation_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  next_poll_at timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO fleet_reconciliation_clock DEFAULT VALUES;

-- Only malformed groups need recovery state. Remember the smaller request
-- size across workers/restarts so a damaged fleet cannot monopolize a poll.
CREATE TABLE fleet_reconciliation_retries (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id) ON DELETE CASCADE,
  batch_size smallint NOT NULL CHECK (batch_size BETWEEN 1 AND 48),
  read_detail boolean NOT NULL DEFAULT false CHECK (NOT read_detail OR batch_size = 1),
  retry_at timestamptz NOT NULL
);

-- One configured Application principal per installation. The binding includes
-- its credential. This caches extension features, never server identity or ACLs.
CREATE TABLE blueprint_capability_discovery (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  binding text,
  checked_at timestamptz,
  extension jsonb
);
INSERT INTO blueprint_capability_discovery DEFAULT VALUES;
