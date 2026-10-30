-- Forge discovery only; existing mappings, combinations and servers remain unchanged.
ALTER TABLE minecraft_metadata_sync DROP CONSTRAINT minecraft_metadata_sync_id_check;
ALTER TABLE minecraft_metadata_sync ADD CONSTRAINT minecraft_metadata_sync_id_check
  CHECK (id IN ('mojang', 'fabric', 'paper', 'forge'));
-- Until applied, the worker skips Forge and readers return an empty catalog.
INSERT INTO minecraft_metadata_sync (id) VALUES ('forge') ON CONFLICT (id) DO NOTHING;
