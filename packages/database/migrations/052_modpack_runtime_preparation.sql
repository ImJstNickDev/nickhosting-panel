-- Explicit Install can prepare the runtime while pack downloads are in progress.
-- Keep its checkpoint independently of the complete pack manifest for recovery.
ALTER TABLE minecraft_modpack_operations ADD COLUMN runtime_preparation jsonb;
