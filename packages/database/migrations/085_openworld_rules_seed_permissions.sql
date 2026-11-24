WITH rules_seed_permissions AS (
  SELECT '[{"key":"game.openworld.rules.view","resource":"game.openworld.rules","kind":"additional","legacy":"explicit","labelKey":"games.openworld.permissions.viewRules","resourceLabelKey":"games.openworld.rules.title","descriptionKey":"games.openworld.permissions.viewRulesHelp"},{"key":"game.openworld.rules.manage","resource":"game.openworld.rules","kind":"additional","legacy":"explicit","labelKey":"games.openworld.permissions.manageRules","resourceLabelKey":"games.openworld.rules.title","descriptionKey":"games.openworld.permissions.manageRulesHelp"},{"key":"game.openworld.bans.manage","resource":"game.openworld.bans","kind":"additional","legacy":"explicit","labelKey":"games.openworld.permissions.manageBans","resourceLabelKey":"games.openworld.rules.bans","descriptionKey":"games.openworld.permissions.manageBansHelp"},{"key":"game.openworld.seed.inspect","resource":"game.openworld.seed","kind":"additional","legacy":"explicit","labelKey":"games.openworld.permissions.inspectSeed","resourceLabelKey":"games.openworld.seed.title","descriptionKey":"games.openworld.permissions.inspectSeedHelp"}]'::jsonb AS definitions
)
UPDATE game_integrations g
SET manifest = jsonb_set(g.manifest, '{serverPermissions}', rules_seed_permissions.definitions || COALESCE((
      SELECT jsonb_agg(permission ORDER BY ordinal)
      FROM jsonb_array_elements(COALESCE(g.manifest->'serverPermissions', '[]'::jsonb))
        WITH ORDINALITY AS items(permission, ordinal)
      WHERE NOT rules_seed_permissions.definitions @> jsonb_build_array(jsonb_build_object('key', permission->>'key'))
    ), '[]'::jsonb)),
    updated_at = now()
FROM rules_seed_permissions
WHERE g.id = 'openworld' AND g.version = '1.0.0'
  AND g.manifest @> '{"id":"openworld","runtimes":[{"id":"dedicated"}]}'::jsonb
  AND NOT COALESCE(g.manifest->'serverPermissions', '[]'::jsonb) @> rules_seed_permissions.definitions;
