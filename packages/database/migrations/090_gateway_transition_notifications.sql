SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

-- Commit-only hints, shared with terminal sleep receipts. PostgreSQL coalesces
-- identical notifications within a transaction. The listener rereads evidence.
CREATE FUNCTION notify_gateway_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('nh_gateway_' || md5(current_database() || ':' || current_schema()), '');
  RETURN NULL;
END
$$;

CREATE TRIGGER gateway_power_transition AFTER UPDATE ON managed_servers
FOR EACH ROW WHEN (
  (OLD.connection_mode = 'gateway' OR NEW.connection_mode = 'gateway') AND
  (OLD.intent, OLD.runtime_state, OLD.deleted_at, OLD.connection_mode)
    IS DISTINCT FROM (NEW.intent, NEW.runtime_state, NEW.deleted_at, NEW.connection_mode)
) EXECUTE FUNCTION notify_gateway_transition();

CREATE TRIGGER gateway_readiness_transition AFTER UPDATE ON gateway_server_states
FOR EACH ROW WHEN (
  (OLD.state, OLD.enabled, OLD.generation, OLD.process_started_at)
    IS DISTINCT FROM (NEW.state, NEW.enabled, NEW.generation, NEW.process_started_at)
) EXECUTE FUNCTION notify_gateway_transition();
