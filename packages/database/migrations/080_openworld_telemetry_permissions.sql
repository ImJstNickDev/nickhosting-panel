-- Refresh the bundled Openworld declaration without replacing unrelated Owner metadata.
WITH telemetry AS (
  SELECT '[
      {"key":"game.openworld.players.read","resource":"game.openworld.players","kind":"read","legacy":"read","labelKey":"games.openworld.permissions.viewPlayers","resourceLabelKey":"games.openworld.telemetry.players"},
      {"key":"game.openworld.players.inspect","resource":"game.openworld.players","kind":"additional","legacy":"explicit","labelKey":"games.openworld.permissions.inspect","resourceLabelKey":"games.openworld.telemetry.players","descriptionKey":"games.openworld.permissions.inspectHelp"},
      {"key":"game.openworld.players.moderate","resource":"game.openworld.players","kind":"additional","legacy":"explicit","labelKey":"games.openworld.permissions.moderate","resourceLabelKey":"games.openworld.telemetry.players","descriptionKey":"games.openworld.permissions.moderateHelp"},
      {"key":"game.openworld.performance.read","resource":"game.openworld.performance","kind":"read","legacy":"read","labelKey":"games.openworld.permissions.viewPerformance","resourceLabelKey":"games.openworld.telemetry.performance"}
  ]'::jsonb AS permissions
)
UPDATE game_integrations AS g
SET manifest = jsonb_set(manifest, '{capabilities,players}', 'true'::jsonb)
    || jsonb_build_object(
      'serverPermissions', telemetry.permissions || COALESCE((
        SELECT jsonb_agg(permission ORDER BY ordinal)
        FROM jsonb_array_elements(COALESCE(g.manifest->'serverPermissions', '[]'::jsonb))
          WITH ORDINALITY AS items(permission, ordinal)
        WHERE NOT telemetry.permissions @> jsonb_build_array(jsonb_build_object('key', permission->>'key'))
      ), '[]'::jsonb),
      'management', COALESCE((
        SELECT jsonb_agg(entry ORDER BY ordinal)
        FROM jsonb_array_elements(COALESCE(g.manifest->'management','[]'::jsonb))
          WITH ORDINALITY AS items(entry, ordinal)
        WHERE entry->>'id' <> 'players'
      ), '[]'::jsonb) || '[{"id":"players","titleKey":"games.openworld.telemetry.players","requiredCapability":"players"}]'::jsonb
    ),
    updated_at = now()
FROM telemetry
WHERE g.id='openworld' AND g.version='1.0.0'
  AND g.manifest @> '{"id":"openworld","runtimes":[{"id":"dedicated"}]}'::jsonb;
