ALTER TABLE server_allocations
  ADD COLUMN private_only boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT server_allocation_private_only CHECK (
    NOT private_only OR (NOT is_primary AND direct_endpoint IS NULL)
  );
