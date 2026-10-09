-- Retain provider allocation identity separately from the effective Docker bind.
-- Older supported allocations were direct private binds, so no instance values
-- or loopback remapping assumptions are introduced by this backfill.
ALTER TABLE server_allocations ADD COLUMN backend_address text;
UPDATE server_allocations SET backend_address = address;
ALTER TABLE server_allocations ALTER COLUMN backend_address SET NOT NULL;

CREATE FUNCTION prevent_allocation_identity_retarget() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.node_id IS DISTINCT FROM OLD.node_id
    OR NEW.server_id IS DISTINCT FROM OLD.server_id
    OR NEW.pterodactyl_allocation_id IS DISTINCT FROM OLD.pterodactyl_allocation_id
    OR NEW.address IS DISTINCT FROM OLD.address
    OR NEW.backend_address IS DISTINCT FROM OLD.backend_address
    OR NEW.port IS DISTINCT FROM OLD.port THEN
    RAISE EXCEPTION 'allocation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_allocation_identity
BEFORE UPDATE ON server_allocations
FOR EACH ROW EXECUTE FUNCTION prevent_allocation_identity_retarget();
