-- Update the declaration registered by the original dedicated-server integration.
UPDATE game_integrations
SET manifest = jsonb_set(manifest, '{capabilities,idleDetection}', 'true'::jsonb, false),
    updated_at = now()
WHERE id = 'openworld'
  AND version = '1.0.0'
  AND manifest @> '{"id":"openworld","version":"1.0.0","nameKey":"games.openworld.name","runtimes":[{"id":"dedicated"}],"capabilities":{"idleDetection":false}}'::jsonb;
