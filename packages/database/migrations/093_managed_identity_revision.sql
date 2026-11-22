SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

-- A fleet sample updates the server row every poll. Keep a separate generation
-- for identity and admission changes so short-lived read proofs survive telemetry.
ALTER TABLE managed_servers ADD COLUMN provider_identity_revision bigint NOT NULL DEFAULT 1;

CREATE FUNCTION bump_managed_identity_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.provider_identity_revision := OLD.provider_identity_revision + 1;
  RETURN NEW;
END
$$;

CREATE TRIGGER managed_identity_revision BEFORE UPDATE OF
  id, owner_id, project_id, mapping_id, node_id, external_id, provider_user_id,
  pterodactyl_id, pterodactyl_uuid, pterodactyl_identifier, connection_mode,
  installation_state, active_operation_id, deleted_at, provider_identity_revision
ON managed_servers FOR EACH ROW WHEN (
  OLD.provider_identity_revision IS DISTINCT FROM NEW.provider_identity_revision OR
  (OLD.id, OLD.owner_id, OLD.project_id, OLD.mapping_id, OLD.node_id, OLD.external_id,
   OLD.provider_user_id, OLD.pterodactyl_id, OLD.pterodactyl_uuid, OLD.pterodactyl_identifier,
   OLD.connection_mode, OLD.installation_state, OLD.active_operation_id, OLD.deleted_at)
  IS DISTINCT FROM
  (NEW.id, NEW.owner_id, NEW.project_id, NEW.mapping_id, NEW.node_id, NEW.external_id,
   NEW.provider_user_id, NEW.pterodactyl_id, NEW.pterodactyl_uuid, NEW.pterodactyl_identifier,
   NEW.connection_mode, NEW.installation_state, NEW.active_operation_id, NEW.deleted_at)
) EXECUTE FUNCTION bump_managed_identity_revision();

-- An allocation or route may be removed then restored between samples. Fence
-- these membership edits even when the visible set is identical at both ends.
-- On allocation UPDATE the retained row xmin changes (including a primary flip
-- and restoration). Migration 009 also forbids moving its owner or endpoint.
-- Route lease renewals and allocation updates need no extra generation writes.
CREATE FUNCTION bump_member_server_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE managed_servers SET provider_identity_revision=provider_identity_revision+1 WHERE id=OLD.server_id;
  ELSIF TG_OP = 'INSERT' THEN
    UPDATE managed_servers SET provider_identity_revision=provider_identity_revision+1 WHERE id=NEW.server_id;
  ELSE
    UPDATE managed_servers SET provider_identity_revision=provider_identity_revision+1 WHERE id IN (OLD.server_id, NEW.server_id);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER allocation_identity_membership AFTER INSERT OR DELETE ON server_allocations
FOR EACH ROW EXECUTE FUNCTION bump_member_server_identity();
CREATE TRIGGER gateway_identity_membership AFTER INSERT OR DELETE ON gateway_routes
FOR EACH ROW EXECUTE FUNCTION bump_member_server_identity();
CREATE TRIGGER gateway_identity_endpoint AFTER UPDATE OF gateway_id, server_id, allocation_id,
  public_address, public_port, transport, enabled ON gateway_routes FOR EACH ROW WHEN (
  (OLD.gateway_id, OLD.server_id, OLD.allocation_id, OLD.public_address, OLD.public_port, OLD.transport, OLD.enabled)
  IS DISTINCT FROM
  (NEW.gateway_id, NEW.server_id, NEW.allocation_id, NEW.public_address, NEW.public_port, NEW.transport, NEW.enabled)
) EXECUTE FUNCTION bump_member_server_identity();
