-- Discovery only: no runtime combinations, rollout changes or server mutations.
ALTER TABLE minecraft_metadata_sync DROP CONSTRAINT minecraft_metadata_sync_id_check;
ALTER TABLE minecraft_metadata_sync ADD CONSTRAINT minecraft_metadata_sync_id_check
  CHECK (id IN ('mojang', 'fabric'));
-- The seed also gates hot-reloaded workers safely before this migration is applied.
INSERT INTO minecraft_metadata_sync (id) VALUES ('fabric') ON CONFLICT (id) DO NOTHING;
