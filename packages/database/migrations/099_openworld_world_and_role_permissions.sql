WITH editor_permissions AS (
  SELECT '[{"key":"game.openworld.territory.manage","resource":"game.openworld.territory","kind":"additional","legacy":"explicit","labelKey":"games.openworld.permissions.manageTerritory","resourceLabelKey":"games.openworld.rules.zones","descriptionKey":"games.openworld.permissions.manageTerritoryHelp"},{"key":"game.openworld.roles.manage","resource":"game.openworld.roles","kind":"additional","legacy":"explicit","labelKey":"games.openworld.permissions.manageRoles","resourceLabelKey":"games.openworld.rules.roles","descriptionKey":"games.openworld.permissions.manageRolesHelp"}]'::jsonb AS definitions
)
UPDATE game_integrations g
SET manifest = jsonb_set(g.manifest, '{serverPermissions}', editor_permissions.definitions || COALESCE((
      SELECT jsonb_agg(permission ORDER BY ordinal)
      FROM jsonb_array_elements(COALESCE(g.manifest->'serverPermissions', '[]'::jsonb))
        WITH ORDINALITY AS items(permission, ordinal)
      WHERE NOT editor_permissions.definitions @> jsonb_build_array(jsonb_build_object('key', permission->>'key'))
    ), '[]'::jsonb)),
    updated_at = now()
FROM editor_permissions
WHERE g.id = 'openworld' AND g.version = '1.0.0'
  AND g.manifest @> '{"id":"openworld","runtimes":[{"id":"dedicated"}]}'::jsonb
  AND NOT COALESCE(g.manifest->'serverPermissions', '[]'::jsonb) @> editor_permissions.definitions;
