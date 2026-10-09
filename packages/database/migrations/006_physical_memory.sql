-- Wings adds memory overhead above the Panel's configured game/installer limit.
-- Keep user quotas in configured MiB; physical admission uses a conservative bound.
ALTER TABLE managed_nodes ADD COLUMN memory_overhead_percent integer NOT NULL DEFAULT 115
  CHECK (memory_overhead_percent BETWEEN 100 AND 400);
ALTER TABLE resource_reservations ADD COLUMN physical_memory_mib integer;
UPDATE resource_reservations AS reservation
SET physical_memory_mib = ceil(reservation.memory_mib::numeric * node.memory_overhead_percent / 100)::integer
FROM managed_servers AS server JOIN managed_nodes AS node ON node.id = server.node_id
WHERE reservation.server_id = server.id;
ALTER TABLE resource_reservations
  ALTER COLUMN physical_memory_mib SET NOT NULL,
  ADD CONSTRAINT resource_physical_memory_minimum CHECK (physical_memory_mib >= memory_mib);
UPDATE installation_reservations AS reservation
SET memory_mib = ceil(greatest(reservation.memory_mib, (server.limits->>'memory')::integer, node.installer_memory_mib)::numeric * node.memory_overhead_percent / 100)::integer
FROM managed_servers AS server JOIN managed_nodes AS node ON node.id = server.node_id
WHERE reservation.server_id = server.id;
