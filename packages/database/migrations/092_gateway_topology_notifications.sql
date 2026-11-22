SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

-- Commit-only hints. Periodic evidence checks remain authoritative on reconnect.
CREATE TRIGGER gateway_registry_membership AFTER INSERT OR DELETE ON gateway_routes
FOR EACH STATEMENT EXECUTE FUNCTION notify_gateway_transition();
CREATE TRIGGER gateway_registry_endpoint AFTER UPDATE ON gateway_routes
FOR EACH ROW WHEN (
  (OLD.gateway_id, OLD.server_id, OLD.allocation_id, OLD.public_address, OLD.public_port, OLD.transport, OLD.enabled)
    IS DISTINCT FROM
  (NEW.gateway_id, NEW.server_id, NEW.allocation_id, NEW.public_address, NEW.public_port, NEW.transport, NEW.enabled)
) EXECUTE FUNCTION notify_gateway_transition();

CREATE TRIGGER gateway_node_topology AFTER INSERT OR UPDATE OR DELETE ON managed_nodes
FOR EACH STATEMENT EXECUTE FUNCTION notify_gateway_transition();
CREATE TRIGGER gateway_allocation_topology AFTER INSERT OR UPDATE OR DELETE ON server_allocations
FOR EACH STATEMENT EXECUTE FUNCTION notify_gateway_transition();
CREATE TRIGGER gateway_mapping_topology AFTER INSERT OR UPDATE OR DELETE ON runtime_egg_mappings
FOR EACH STATEMENT EXECUTE FUNCTION notify_gateway_transition();

CREATE TRIGGER gateway_server_identity AFTER UPDATE ON managed_servers
FOR EACH ROW WHEN (
  (OLD.connection_mode = 'gateway' OR NEW.connection_mode = 'gateway') AND
  (OLD.node_id, OLD.mapping_id, OLD.owner_id, OLD.external_id, OLD.pterodactyl_id,
   OLD.pterodactyl_uuid, OLD.pterodactyl_identifier, OLD.provider_user_id, OLD.active_operation_id)
    IS DISTINCT FROM
  (NEW.node_id, NEW.mapping_id, NEW.owner_id, NEW.external_id, NEW.pterodactyl_id,
   NEW.pterodactyl_uuid, NEW.pterodactyl_identifier, NEW.provider_user_id, NEW.active_operation_id)
) EXECUTE FUNCTION notify_gateway_transition();
