-- Purpur discovery only; existing mappings and servers are unchanged.
ALTER TABLE minecraft_metadata_sync DROP CONSTRAINT minecraft_metadata_sync_id_check;
ALTER TABLE minecraft_metadata_sync ADD CONSTRAINT minecraft_metadata_sync_id_check
  CHECK (id IN ('mojang', 'fabric', 'paper', 'forge', 'neoforge', 'purpur'));
INSERT INTO minecraft_metadata_sync (id) VALUES ('purpur') ON CONFLICT (id) DO NOTHING;
