-- Durable manual discovery requests, consumed by the existing metadata worker.
-- Null preserves the scheduled behavior of Mojang and idle Fabric rows.
ALTER TABLE minecraft_metadata_sync ADD COLUMN requested_at timestamptz;
