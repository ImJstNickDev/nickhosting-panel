-- NeoForge discovery only; no existing runtime mapping or server is modified.
ALTER TABLE minecraft_metadata_sync DROP CONSTRAINT minecraft_metadata_sync_id_check;
ALTER TABLE minecraft_metadata_sync ADD CONSTRAINT minecraft_metadata_sync_id_check
  CHECK (id IN ('mojang', 'fabric', 'paper', 'forge', 'neoforge'));
INSERT INTO minecraft_metadata_sync (id) VALUES ('neoforge') ON CONFLICT (id) DO NOTHING;
