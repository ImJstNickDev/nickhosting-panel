CREATE TABLE satisfactory_mod_inventory_observations (
  server_id uuid PRIMARY KEY REFERENCES managed_servers(id) ON DELETE CASCADE,
  binding text,
  inventory jsonb,
  observed_at timestamptz,
  lease_id uuid,
  lease_binding text,
  lease_until timestamptz,
  CHECK ((binding IS NULL) = (inventory IS NULL) AND (inventory IS NULL) = (observed_at IS NULL)),
  CHECK ((lease_id IS NULL) = (lease_binding IS NULL) AND (lease_id IS NULL) = (lease_until IS NULL))
);
