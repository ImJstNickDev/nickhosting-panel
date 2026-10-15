-- Global content policy replaces historical Minecraft-only settings. Durable
-- rows, identity digests, storage locations and reservations remain unchanged.
ALTER TABLE minecraft_sources ADD COLUMN game_id text NOT NULL DEFAULT 'minecraft'
  CHECK (game_id ~ '^[a-z][a-z0-9-]{0,63}$');
ALTER TABLE minecraft_staging_claims ADD COLUMN game_id text NOT NULL DEFAULT 'minecraft'
  CHECK (game_id ~ '^[a-z][a-z0-9-]{0,63}$');
CREATE INDEX content_sources_game_capacity ON minecraft_sources(game_id, owner_user_id, state);
CREATE INDEX content_stages_game_capacity ON minecraft_staging_claims(game_id, owner_user_id, state);

DO $$
DECLARE aliases jsonb := '{
  "minecraftMetadataUserAgent": "contentMetadataUserAgent",
  "minecraftSourceRoot": "contentSourceRoot",
  "minecraftContentRoot": "contentWorkRoot",
  "minecraftSourceGlobalBytes": "contentSourceGlobalBytes",
  "minecraftSourceUserBytes": "contentSourceUserBytes",
  "minecraftSourceConcurrent": "contentSourceConcurrent",
  "minecraftSourceUserConcurrent": "contentSourceUserConcurrent",
  "minecraftSourceFreeBytes": "contentSourceFreeBytes",
  "minecraftSourceFreePercent": "contentSourceFreePercent",
  "minecraftDownloadOrigins": "contentDownloadOrigins"
}'; item record;
BEGIN
  FOR item IN SELECT key, value FROM jsonb_each_text(aliases) LOOP
    UPDATE platform_settings SET value = (value - item.key) ||
      CASE WHEN value ? item.value THEN '{}'::jsonb
        ELSE jsonb_build_object(item.value, value->item.key) END
    WHERE key = 'platform' AND value ? item.key;
  END LOOP;
END $$;
