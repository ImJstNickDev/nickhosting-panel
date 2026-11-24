WITH map_permissions AS (
  SELECT '[{"key":"game.openworld.map.read","resource":"game.openworld.map","kind":"read","legacy":"read","labelKey":"games.openworld.permissions.viewMap","resourceLabelKey":"games.openworld.map.title"},{"key":"game.openworld.checkpoints.manage","resource":"game.openworld.checkpoints","kind":"additional","legacy":"explicit","labelKey":"games.openworld.permissions.manageCheckpoints","resourceLabelKey":"games.openworld.map.checkpoints","descriptionKey":"games.openworld.permissions.manageCheckpointsHelp"}]'::jsonb AS definitions
)
UPDATE game_integrations g
SET manifest = jsonb_set(g.manifest, '{serverPermissions}', map_permissions.definitions || COALESCE((
      SELECT jsonb_agg(permission ORDER BY ordinal)
      FROM jsonb_array_elements(COALESCE(g.manifest->'serverPermissions', '[]'::jsonb))
        WITH ORDINALITY AS items(permission, ordinal)
      WHERE NOT map_permissions.definitions @> jsonb_build_array(jsonb_build_object('key', permission->>'key'))
    ), '[]'::jsonb)),
    updated_at = now()
FROM map_permissions
WHERE g.id = 'openworld' AND g.version = '1.0.0'
  AND g.manifest @> '{"id":"openworld","runtimes":[{"id":"dedicated"}]}'::jsonb
  AND NOT COALESCE(g.manifest->'serverPermissions', '[]'::jsonb) @> map_permissions.definitions;
