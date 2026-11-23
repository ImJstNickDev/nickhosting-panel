SET LOCAL lock_timeout = '2s';

-- Serialize the registry transition with in-flight DNS plans and their provider callbacks.
SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':external:dns', 0));

UPDATE game_integrations
SET manifest = jsonb_set(manifest, '{connection,srv}', '{"service":"_openworld","proto":"udp"}'),
    updated_at = now()
WHERE id = 'openworld' AND version = '1.0.0'
  AND manifest @> '{"id":"openworld","runtimes":[{"id":"dedicated"}],"ports":[{"role":"game","transport":"udp"}]}'
  AND manifest->'connection' = '{"mode":"custom-subdomain","zoneSettingKey":"dnsBaseDomain"}'::jsonb;

-- Keep the confirmed address and web publication available during the additive DNS change.
-- The worker rechecks the public allocation, authority and provider ownership under lock.
UPDATE dns_assignments d
SET plan = jsonb_set(d.plan, '{reconcileSrv}', 'true')
FROM managed_servers s
JOIN runtime_egg_mappings m ON m.id = s.mapping_id
JOIN game_integrations g ON g.id = m.game_id
JOIN server_allocations a ON a.server_id = s.id AND a.is_primary
WHERE d.server_id = s.id AND s.deleted_at IS NULL AND s.pterodactyl_uuid IS NOT NULL
  AND m.game_id = 'openworld' AND m.runtime_id = 'dedicated'
  AND g.manifest->'connection' @> '{"mode":"custom-subdomain","srv":{"service":"_openworld","proto":"udp"}}'
  AND a.role = 'game' AND 'udp' = ANY(a.protocols)
  AND d.state IN ('pending', 'active', 'uncertain') AND d.plan->>'action' = 'apply'
  AND NOT (d.plan ? 'sharedHostId')
  AND coalesce(d.plan#>>'{request,portRole}', a.role) = a.role
  AND d.plan#>>'{connection,hostname}' = d.hostname
  AND jsonb_typeof(d.plan#>'{connection,records}') = 'array'
  AND d.plan#>'{connection,records,1}' IS NULL
  AND d.plan#>>'{connection,records,0,type}' IN ('A','AAAA','CNAME')
  AND d.plan#>>'{connection,records,0,name}' = d.hostname
  AND EXISTS (SELECT 1 FROM dns_hostname_reservations r
              WHERE r.owner_id = d.id AND r.hostname = d.hostname AND r.release_after IS NULL);

CREATE INDEX dns_assignments_srv_upgrade ON dns_assignments (updated_at, id)
  WHERE state NOT IN ('active', 'deleted')
     OR (state = 'active' AND plan @> '{"reconcileSrv":true}');
