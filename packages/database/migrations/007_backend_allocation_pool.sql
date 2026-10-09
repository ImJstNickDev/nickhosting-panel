-- No instance allocation inventory is seeded. Provisioning stays disabled until
-- the Owner configures and validates a private backend / gateway bind matrix.
ALTER TABLE managed_nodes ADD COLUMN backend_allocation_pool jsonb;
ALTER TABLE managed_nodes ADD CONSTRAINT backend_allocation_pool_object
  CHECK (backend_allocation_pool IS NULL OR jsonb_typeof(backend_allocation_pool) = 'object');
