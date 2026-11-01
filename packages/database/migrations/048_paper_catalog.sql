-- Discovery only: existing mappings, combinations and game servers remain unchanged.
ALTER TABLE minecraft_metadata_sync DROP CONSTRAINT minecraft_metadata_sync_id_check;
ALTER TABLE minecraft_metadata_sync ADD CONSTRAINT minecraft_metadata_sync_id_check
  CHECK (id IN ('mojang', 'fabric', 'paper'));
-- The seed gates hot-reloaded workers until this migration is applied.
INSERT INTO minecraft_metadata_sync (id) VALUES ('paper') ON CONFLICT (id) DO NOTHING;
