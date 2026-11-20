SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- A NULL due_at parks a stable state outside the worker's partial index. A
-- pending signal takes precedence over a later readiness heartbeat/deadline.
CREATE TABLE gateway_reconciliation (
  server_id uuid PRIMARY KEY REFERENCES gateway_server_states(server_id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1,
  pending boolean NOT NULL,
  due_at timestamptz
);
CREATE INDEX gateway_reconciliation_due ON gateway_reconciliation(due_at,server_id)
WHERE due_at IS NOT NULL;
CREATE INDEX gateway_sleep_job_reconcile ON gateway_server_states(sleep_job_id) WHERE sleep_job_id IS NOT NULL;
CREATE INDEX gateway_wake_job_reconcile ON gateway_server_states(wake_job_id) WHERE wake_job_id IS NOT NULL AND state='waking';

CREATE FUNCTION gateway_reconcile_deadline(s gateway_server_states) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE
    -- The existing worker keeps an uncertain terminal sleep fenced while its
    -- durable marker remains. A new reservation/job observation wakes it sooner.
    WHEN s.state IN ('maintenance','manually_stopped') THEN NULL
    WHEN s.sleep_job_id IS NOT NULL THEN CASE WHEN s.blocked_until IS NOT NULL THEN now()+interval '5 seconds' END
    -- Reconciliation expires on strict '>' in the millisecond application clock.
    WHEN s.state='waking' THEN s.startup_deadline_at + interval '1 millisecond'
    WHEN s.state='online' THEN s.readiness_observed_at + s.readiness_max_age_seconds * interval '1 second' + interval '1 millisecond'
  END
$$;

CREATE FUNCTION queue_gateway_reconciliation(server uuid, immediate boolean, deadline timestamptz DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO gateway_reconciliation(server_id,pending,due_at)
  SELECT s.server_id, immediate, CASE WHEN immediate THEN now() ELSE deadline END
  FROM gateway_server_states s JOIN managed_servers m ON m.id=s.server_id
  WHERE s.server_id=server AND m.deleted_at IS NULL
  ON CONFLICT (server_id) DO UPDATE SET
    revision=gateway_reconciliation.revision+1,
    pending=gateway_reconciliation.pending OR excluded.pending,
    due_at=CASE WHEN excluded.pending THEN least(gateway_reconciliation.due_at,excluded.due_at)
                WHEN gateway_reconciliation.pending THEN gateway_reconciliation.due_at
                ELSE excluded.due_at END
$$;

CREATE FUNCTION gateway_reconcile_needs_check(s gateway_server_states, m managed_servers) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT s.sleep_job_id IS NOT NULL OR (s.state='waking' AND s.wake_job_id IS NOT NULL)
    OR m.connection_mode='direct' OR m.pterodactyl_uuid IS NULL
    OR (m.intent IN ('maintenance','manually_stopped')
        AND (s.state<>m.intent OR s.readiness_observed_at IS NOT NULL OR s.idle_since IS NOT NULL))
    OR (s.state='online' AND (m.runtime_state<>'running' OR s.process_started_at IS NULL
        OR s.readiness_observed_at IS NULL OR s.readiness_observed_at>statement_timestamp()))
$$;

-- Deferred triggers publish hints after the domain writes, in the same commit.
-- A normal readiness refresh only moves its deadline; polling reads no healthy rows.
CREATE FUNCTION schedule_gateway_state_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  immediate boolean;
BEGIN
  IF TG_OP='INSERT' OR
    (OLD.state,OLD.sleep_job_id,OLD.wake_job_id,OLD.process_started_at)
    IS DISTINCT FROM (NEW.state,NEW.sleep_job_id,NEW.wake_job_id,NEW.process_started_at)
  THEN
    SELECT gateway_reconcile_needs_check(NEW,m) INTO immediate FROM managed_servers m WHERE m.id=NEW.server_id;
  ELSE
    immediate := (NEW.state='online' AND (NEW.readiness_observed_at IS NULL OR NEW.readiness_observed_at>clock_timestamp()))
      OR (NEW.state IN ('maintenance','manually_stopped') AND (NEW.readiness_observed_at IS NOT NULL OR NEW.idle_since IS NOT NULL));
  END IF;
  PERFORM queue_gateway_reconciliation(NEW.server_id, immediate, gateway_reconcile_deadline(NEW));
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER gateway_reconcile_state_insert AFTER INSERT ON gateway_server_states
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION schedule_gateway_state_reconciliation();
CREATE CONSTRAINT TRIGGER gateway_reconcile_state_change AFTER UPDATE ON gateway_server_states
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (
  (OLD.state,OLD.sleep_job_id,OLD.wake_job_id,OLD.process_started_at,OLD.readiness_observed_at,
   OLD.readiness_max_age_seconds,OLD.startup_deadline_at)
    IS DISTINCT FROM (NEW.state,NEW.sleep_job_id,NEW.wake_job_id,NEW.process_started_at,NEW.readiness_observed_at,
   NEW.readiness_max_age_seconds,NEW.startup_deadline_at)
  OR (NEW.state IN ('maintenance','manually_stopped') AND OLD.idle_since IS DISTINCT FROM NEW.idle_since)
  OR (NEW.sleep_job_id IS NOT NULL AND (OLD.blocked_until IS NULL) <> (NEW.blocked_until IS NULL))
) EXECUTE FUNCTION schedule_gateway_state_reconciliation();

CREATE FUNCTION signal_gateway_server_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM gateway_reconciliation WHERE server_id=NEW.id;
  ELSE
    PERFORM queue_gateway_reconciliation(NEW.id,true);
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER gateway_reconcile_server_change AFTER UPDATE ON managed_servers
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (
  (OLD.intent,OLD.runtime_state,OLD.active_operation_id,OLD.pterodactyl_uuid,OLD.connection_mode,OLD.deleted_at)
  IS DISTINCT FROM (NEW.intent,NEW.runtime_state,NEW.active_operation_id,NEW.pterodactyl_uuid,NEW.connection_mode,NEW.deleted_at)
) EXECUTE FUNCTION signal_gateway_server_change();

CREATE FUNCTION signal_gateway_job_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM queue_gateway_reconciliation(s.server_id,true)
  FROM gateway_server_states s WHERE s.sleep_job_id=NEW.id OR (s.state='waking' AND s.wake_job_id=NEW.id);
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER gateway_reconcile_job_completion AFTER UPDATE ON operation_jobs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state IN ('succeeded','failed')
  AND (OLD.state,OLD.completed_at) IS DISTINCT FROM (NEW.state,NEW.completed_at))
EXECUTE FUNCTION signal_gateway_job_completion();

CREATE FUNCTION signal_gateway_sleep_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid := CASE WHEN TG_OP='DELETE' THEN OLD.server_id ELSE NEW.server_id END;
BEGIN
  IF EXISTS(SELECT 1 FROM gateway_server_states WHERE server_id=subject AND sleep_job_id IS NOT NULL) THEN
    PERFORM queue_gateway_reconciliation(subject,true);
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER gateway_reconcile_sleep_reservation AFTER INSERT OR DELETE ON resource_reservations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION signal_gateway_sleep_reservation();

-- Recover checkpoints adjusted after a terminal job was first observed.
CREATE FUNCTION signal_gateway_terminal_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM gateway_server_states s JOIN operation_jobs j ON j.id=NEW.job_id
      WHERE s.server_id=NEW.server_id AND j.state='failed'
        AND (s.sleep_job_id=j.id OR (s.state='waking' AND s.wake_job_id=j.id))) THEN
    PERFORM queue_gateway_reconciliation(NEW.server_id,true);
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER gateway_reconcile_terminal_checkpoint AFTER UPDATE ON server_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (
  NEW.action IN ('stop','restart','backup') AND
  (OLD.action,OLD.phase,OLD.effect_state,OLD.effect_started_at,OLD.plan)
  IS DISTINCT FROM (NEW.action,NEW.phase,NEW.effect_state,NEW.effect_started_at,NEW.plan)
) EXECUTE FUNCTION signal_gateway_terminal_checkpoint();

-- Backfill existing interrupted jobs and timers. Healthy, parked records have
-- no due index entry even on the first tick after the migration or a restart.
INSERT INTO gateway_reconciliation(server_id,pending,due_at)
SELECT s.server_id, due.immediate, CASE WHEN due.immediate THEN now() ELSE gateway_reconcile_deadline(s) END
FROM gateway_server_states s JOIN managed_servers m ON m.id=s.server_id
CROSS JOIN LATERAL (SELECT gateway_reconcile_needs_check(s,m) AS immediate) due
WHERE m.deleted_at IS NULL;
