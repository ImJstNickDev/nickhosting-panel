-- Application identity only. Java protocol/handler IDs, signed evidence,
-- combination/choice digests, job command hashes, receipts and history stay intact.
-- Stop old application processes before applying and restart the updated build.
LOCK TABLE game_integrations, game_rollouts, runtime_egg_mappings,
  platform_settings, file_viewer_preferences IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM game_integrations WHERE id = 'minecraft-java')
    AND EXISTS (SELECT 1 FROM game_integrations WHERE id = 'minecraft') THEN
    RAISE EXCEPTION 'Both Minecraft integration identities exist; resolve explicitly before migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM platform_settings
    WHERE value->'gameIdleTimeouts' ? 'minecraft-java'
      AND value->'gameIdleTimeouts' ? 'minecraft'
  ) THEN
    RAISE EXCEPTION 'Both Minecraft sleep policy identities exist; resolve explicitly before migration';
  END IF;
END $$;

-- Only localization values inside the mutable manifest are renamed recursively.
-- Do not replace arbitrary IDs, runtime names, URLs or signed JSON documents.
CREATE FUNCTION pg_temp.nh_minecraft_manifest_identity(document jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE result jsonb; entry record; value text;
BEGIN
  CASE jsonb_typeof(document)
    WHEN 'object' THEN
      result := '{}';
      FOR entry IN SELECT * FROM jsonb_each(document) LOOP
        result := result || jsonb_build_object(entry.key, pg_temp.nh_minecraft_manifest_identity(entry.value));
      END LOOP;
      RETURN result;
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(pg_temp.nh_minecraft_manifest_identity(item)), '[]'::jsonb)
        INTO result FROM jsonb_array_elements(document) AS items(item);
      RETURN result;
    WHEN 'string' THEN
      value := document #>> '{}';
      IF value = 'games.minecraft-java' OR starts_with(value, 'games.minecraft-java.') THEN
        RETURN to_jsonb('games.minecraft' || substr(value, length('games.minecraft-java') + 1));
      END IF;
      RETURN document;
    ELSE RETURN document;
  END CASE;
END $$;

INSERT INTO game_integrations(id, version, manifest, updated_at)
SELECT 'minecraft', version,
  jsonb_set(pg_temp.nh_minecraft_manifest_identity(manifest), '{id}', '"minecraft"'), updated_at
FROM game_integrations WHERE id = 'minecraft-java';
UPDATE game_rollouts SET integration_id = 'minecraft' WHERE integration_id = 'minecraft-java';
UPDATE runtime_egg_mappings SET game_id = 'minecraft' WHERE game_id = 'minecraft-java';
DELETE FROM game_integrations WHERE id = 'minecraft-java';
DROP FUNCTION pg_temp.nh_minecraft_manifest_identity(jsonb);

UPDATE platform_settings
SET value = jsonb_set(value, '{gameIdleTimeouts}',
  ((value->'gameIdleTimeouts') - 'minecraft-java') ||
    jsonb_build_object('minecraft', value->'gameIdleTimeouts'->'minecraft-java'))
WHERE value->'gameIdleTimeouts' ? 'minecraft-java';

-- A conflicting canonical preference fails its PK constraint and rolls back the
-- complete migration instead of silently picking one user's existing choice.
UPDATE file_viewer_preferences SET scope_id = 'minecraft'
WHERE scope = 'game' AND scope_id = 'minecraft-java';
