-- Existing servers keep their reviewed Gateway delivery identity.
ALTER TABLE managed_servers ADD COLUMN connection_mode text NOT NULL DEFAULT 'gateway' CHECK (connection_mode IN ('gateway', 'direct'));
ALTER TABLE server_allocations ADD COLUMN direct_endpoint jsonb NULL CHECK (direct_endpoint IS NULL OR jsonb_typeof(direct_endpoint) = 'object');
-- An explicit advertised endpoint cannot silently be assigned to two servers.
CREATE UNIQUE INDEX server_direct_endpoint_unique ON server_allocations ((direct_endpoint->>'hostname'), (direct_endpoint->>'port')) WHERE direct_endpoint IS NOT NULL;
