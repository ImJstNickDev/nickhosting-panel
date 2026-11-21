UPDATE game_integrations
SET manifest = jsonb_set(manifest, '{serverPermissions}',
      '[{"key":"game.openworld.players.screenshots","resource":"game.openworld.players","kind":"additional","legacy":"explicit","labelKey":"games.openworld.permissions.screenshots","resourceLabelKey":"games.openworld.telemetry.players","descriptionKey":"games.openworld.permissions.screenshotsHelp"}]'::jsonb
      || coalesce(manifest->'serverPermissions', '[]'::jsonb)),
    updated_at = now()
WHERE id = 'openworld' AND version = '1.0.0'
  AND manifest @> '{"id":"openworld","runtimes":[{"id":"dedicated"}]}'::jsonb
  AND NOT coalesce(manifest->'serverPermissions', '[]'::jsonb)
    @> '[{"key":"game.openworld.players.screenshots"}]'::jsonb;
