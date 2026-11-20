-- Give each managed Minecraft server a stable position within the minute.
CREATE FUNCTION minecraft_world_next_scan(server uuid, at_time timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE STRICT AS $$
  SELECT CASE WHEN slot > at_time THEN slot ELSE slot + interval '1 minute' END
  FROM (SELECT date_trunc('minute', at_time)
    + ((hashtextextended(server::text, 0) & 2147483647) % 60000) * interval '1 millisecond' AS slot) slots
$$;

CREATE TABLE minecraft_world_indexes (
  server_id uuid PRIMARY KEY REFERENCES minecraft_server_profiles(server_id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 0,
  operation_generation bigint NOT NULL DEFAULT 0,
  next_scan_at timestamptz NOT NULL,
  lease_id uuid,
  lease_until timestamptz,
  finished_id uuid,
  denied_reason text CHECK (denied_reason IN ('forbidden','provenance_mismatch','not_found')),
  successful_generation bigint,
  binding text,
  local_binding text,
  snapshot jsonb,
  level_stamps jsonb NOT NULL DEFAULT '[]',
  non_world_directories text[] NOT NULL DEFAULT '{}',
  observed_at timestamptz,
  CHECK ((lease_id IS NULL) = (lease_until IS NULL))
);
CREATE INDEX minecraft_world_indexes_due ON minecraft_world_indexes(next_scan_at);

-- Scope every read/publication to the observation's managed identity. Provider
-- configuration outside the database is checked separately by the runtime.
CREATE FUNCTION minecraft_world_local_binding(server uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(
   s.id, s.owner_id, s.mapping_id, s.external_id, s.provider_user_id, s.pterodactyl_id,
   s.pterodactyl_uuid, s.pterodactyl_identifier, s.node_id, n.pterodactyl_node_id,
   p.combination_id, p.installed, s.installation_state, a.instance_id, a.provider_url,
   a.provider_id, a.provider_uuid, a.external_id, a.key_operation_id, a.key_identifier,
   a.status, f.enabled, f.provider_url, projection.instance_id, projection.revision, projection.valid,
   (SELECT jsonb_agg(jsonb_build_array(c.pterodactyl_allocation_id, c.address, c.port, c.is_primary)
       ORDER BY c.pterodactyl_allocation_id) FROM server_allocations c WHERE c.server_id=s.id)
 )::text,'UTF8')), 'hex')
 FROM managed_servers s
 JOIN minecraft_server_profiles p ON p.server_id=s.id
 JOIN minecraft_combinations combination ON combination.id=p.combination_id AND combination.mapping_id=s.mapping_id
 JOIN runtime_egg_mappings mapping ON mapping.id=s.mapping_id AND mapping.game_id='minecraft'
 JOIN managed_nodes n ON n.id=s.node_id
 LEFT JOIN provider_accounts a ON a.user_id=s.owner_id
 LEFT JOIN provider_change_feeds f ON f.instance_id=a.instance_id
 LEFT JOIN provider_server_projections projection ON projection.server_id=s.id
 WHERE s.id=server AND s.deleted_at IS NULL AND NOT coalesce(projection.identity_invalidated, false)
$$;

CREATE FUNCTION dirty_minecraft_world_index(server uuid) RETURNS void LANGUAGE sql AS $$
 UPDATE minecraft_world_indexes SET generation=generation+1, next_scan_at=least(next_scan_at, now()),
    non_world_directories='{}' WHERE server_id=server
$$;

CREATE FUNCTION initialize_minecraft_world_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO minecraft_world_indexes(server_id,next_scan_at)
 VALUES (NEW.server_id,minecraft_world_next_scan(NEW.server_id,now()));
 RETURN NEW;
END;
$$;
CREATE TRIGGER minecraft_world_index_initialize AFTER INSERT ON minecraft_server_profiles
FOR EACH ROW EXECUTE FUNCTION initialize_minecraft_world_index();
INSERT INTO minecraft_world_indexes(server_id,next_scan_at)
SELECT server_id,minecraft_world_next_scan(server_id,now()) FROM minecraft_server_profiles;

-- Fence observations spanning the start/end of any operation, including failed
-- restores. Queuing a selection does not invalidate its separate action proof.
CREATE FUNCTION schedule_minecraft_world_operation_scan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE minecraft_world_indexes SET operation_generation=operation_generation+1,
   next_scan_at=least(next_scan_at,now()), non_world_directories='{}', level_stamps='[]'
 WHERE server_id=NEW.id;
 RETURN NEW;
END;
$$;
CREATE TRIGGER minecraft_world_operation_scan AFTER UPDATE OF active_operation_id ON managed_servers
FOR EACH ROW WHEN (OLD.active_operation_id IS DISTINCT FROM NEW.active_operation_id)
EXECUTE FUNCTION schedule_minecraft_world_operation_scan();
