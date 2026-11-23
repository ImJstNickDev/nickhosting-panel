SET LOCAL lock_timeout = '2s';

-- DNS planners and provider callbacks hold the same lock across their durable writes.
SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':external:dns', 0));

CREATE VIEW game_connection_versions (server_id, game_id, version) AS
  SELECT server_id, 'openworld'::text, version FROM openworld_server_profiles;

-- A NULL server selects all existing personal game names for the one-time backfill.
-- The compiled integration resolves the version policy when the worker runs.
CREATE FUNCTION enqueue_openworld_dns_policy(affected_server uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE dns_assignments d
     SET plan = jsonb_set(d.plan, '{reconcileSrv}', 'true')
    FROM managed_servers s
    JOIN runtime_egg_mappings m ON m.id = s.mapping_id
    JOIN game_integrations g ON g.id = m.game_id
    JOIN server_allocations a ON a.server_id = s.id AND a.is_primary
   WHERE d.server_id = s.id AND (affected_server IS NULL OR d.server_id = affected_server)
     AND m.game_id = 'openworld' AND m.runtime_id = 'dedicated'
     AND g.manifest->'connection' @> '{"mode":"custom-subdomain","srv":{"service":"_openworld","proto":"udp"}}'
     AND s.deleted_at IS NULL AND s.pterodactyl_uuid IS NOT NULL
     AND a.role = 'game' AND 'udp' = ANY(a.protocols)
     AND coalesce(d.plan#>>'{request,portRole}', a.role) = a.role
     AND d.state IN ('active','pending','uncertain') AND d.plan->>'action' = 'apply'
     AND NOT (d.plan ? 'sharedHostId') AND NOT (d.plan @> '{"reconcileSrv":true}')
     AND d.hostname = d.plan#>>'{connection,hostname}'
     AND EXISTS (SELECT 1 FROM dns_hostname_reservations r
                  WHERE r.hostname = d.hostname AND r.owner_id = d.id AND r.release_after IS NULL);
$$;

CREATE FUNCTION openworld_dns_profile_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.server_id, OLD.version) IS NOT DISTINCT FROM (NEW.server_id, NEW.version) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(current_schema() || ':external:dns', 0));
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.server_id <> NEW.server_id) THEN
    PERFORM enqueue_openworld_dns_policy(OLD.server_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM enqueue_openworld_dns_policy(NEW.server_id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER openworld_dns_profile_version AFTER INSERT OR UPDATE OF version, server_id OR DELETE
  ON openworld_server_profiles FOR EACH ROW EXECUTE FUNCTION openworld_dns_profile_changed();

SELECT enqueue_openworld_dns_policy(NULL);
