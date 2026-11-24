SET LOCAL lock_timeout = '2s';

-- The independent ledger survives game deletion and an NPM response lost after
-- creation. Each row can own at most one exact hostname at any time.
CREATE TABLE openworld_dashboard_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid UNIQUE REFERENCES managed_servers(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  tracked_hostname text,
  proxy_host_id integer CHECK (proxy_host_id IS NULL OR (proxy_host_id > 0 AND tracked_hostname IS NOT NULL)),
  provider_origin text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','error')),
  due_at timestamptz DEFAULT now(),
  CHECK ((tracked_hostname IS NULL) = (provider_origin IS NULL)),
  CHECK (state <> 'active' OR proxy_host_id IS NOT NULL)
);
CREATE INDEX openworld_dashboard_due ON openworld_dashboard_publications(due_at, id) WHERE due_at IS NOT NULL;

-- The default remains unpublished. Even unpublished custom names have a
-- durable TLS request, including assignments predating this migration.
CREATE VIEW openworld_dashboard_dns AS
SELECT s.id AS server_id, d.hostname
  FROM server_dns_preferences p
  JOIN dns_assignments d ON d.id=p.assignment_id AND d.server_id=p.server_id
  JOIN dns_hostname_reservations r ON r.hostname=d.hostname AND r.owner_id=d.id AND r.release_after IS NULL
  JOIN managed_servers s ON s.id=d.server_id
  JOIN runtime_egg_mappings m ON m.id=s.mapping_id
 WHERE p.enabled AND d.state='active' AND s.deleted_at IS NULL AND s.pterodactyl_uuid IS NOT NULL
   AND m.game_id='openworld' AND m.runtime_id='dedicated'
   AND NOT (d.plan ? 'sharedHostId') AND d.hostname=d.plan #>> '{connection,hostname}';

INSERT INTO openworld_dashboard_publications(server_id) SELECT server_id FROM openworld_dashboard_dns;

CREATE FUNCTION queue_openworld_dashboard_for_dns() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected uuid := COALESCE(NEW.server_id, OLD.server_id);
BEGIN
  UPDATE openworld_dashboard_publications SET revision=revision+1, due_at=now(), state='pending'
    WHERE server_id=affected;
  IF NOT FOUND THEN
    INSERT INTO openworld_dashboard_publications(server_id)
      SELECT server_id FROM openworld_dashboard_dns WHERE server_id=affected
      ON CONFLICT(server_id) DO UPDATE SET revision=openworld_dashboard_publications.revision+1, due_at=now();
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER dashboard_dns_state AFTER UPDATE OF hostname, state, plan ON dns_assignments
  FOR EACH ROW WHEN ((OLD.hostname,OLD.state,OLD.plan->>'sharedHostId',OLD.plan#>>'{connection,hostname}')
    IS DISTINCT FROM (NEW.hostname,NEW.state,NEW.plan->>'sharedHostId',NEW.plan#>>'{connection,hostname}'))
  EXECUTE FUNCTION queue_openworld_dashboard_for_dns();
CREATE TRIGGER dashboard_dns_preference AFTER INSERT OR UPDATE OF assignment_id, enabled OR DELETE ON server_dns_preferences
  FOR EACH ROW EXECUTE FUNCTION queue_openworld_dashboard_for_dns();

CREATE FUNCTION queue_openworld_dashboard_for_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE openworld_dashboard_publications SET enabled=false, state='pending', revision=revision+1, due_at=now()
    WHERE server_id=OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER dashboard_game_soft_delete AFTER UPDATE OF deleted_at ON managed_servers
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION queue_openworld_dashboard_for_delete();
CREATE TRIGGER dashboard_game_delete BEFORE DELETE ON managed_servers
  FOR EACH ROW EXECUTE FUNCTION queue_openworld_dashboard_for_delete();

CREATE FUNCTION notify_openworld_dashboard_worker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('nh_dashboards_' || md5(current_database() || ':' || current_schema()), '');
  RETURN NULL;
END $$;
CREATE TRIGGER notify_dashboard_request AFTER INSERT OR UPDATE OF revision ON openworld_dashboard_publications
  FOR EACH ROW EXECUTE FUNCTION notify_openworld_dashboard_worker();
