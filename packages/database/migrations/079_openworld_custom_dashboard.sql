-- Existing native dashboard passwords could previously be revealed. Replace them
-- at the next managed start, without restarting the running game.
ALTER TABLE openworld_server_profiles
  ADD COLUMN dashboard_credential_prepared boolean NOT NULL DEFAULT false;

UPDATE game_integrations
SET manifest = manifest || '{
  "connection":{"mode":"custom-subdomain","zoneSettingKey":"dnsBaseDomain"},
  "serverPermissions":[{
    "key":"game.openworld.dashboard.admin","resource":"game.openworld.dashboard",
    "kind":"additional","legacy":"explicit",
    "labelKey":"games.openworld.dashboard.permission",
    "resourceLabelKey":"games.openworld.dashboard.title",
    "descriptionKey":"games.openworld.dashboard.permissionHelp"
  }]
}'::jsonb, updated_at=now()
WHERE id='openworld' AND version='1.0.0'
  AND manifest @> '{"id":"openworld","runtimes":[{"id":"dedicated"}],
    "connection":{"mode":"shared-host","defaultLabel":"openworld","allowCustomSubdomain":false}}'::jsonb;
