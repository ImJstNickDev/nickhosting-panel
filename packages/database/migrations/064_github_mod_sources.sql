ALTER TABLE minecraft_sources DROP CONSTRAINT minecraft_sources_origin_check;
ALTER TABLE minecraft_sources ADD CONSTRAINT minecraft_sources_origin_check CHECK (origin IN ('upload','modrinth','curseforge','hangar','spiget','github'));
ALTER TABLE minecraft_sources DROP CONSTRAINT minecraft_sources_provider_identity;
ALTER TABLE minecraft_sources ADD CONSTRAINT minecraft_sources_provider_identity CHECK (
 (origin='upload' AND provider_project_id IS NULL AND provider_version_id IS NULL)
 OR (origin='modrinth' AND kind IN ('modpack','datapack','mod','plugin') AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL)
 OR (origin='curseforge' AND kind IN ('world','datapack','mod','plugin') AND server_id IS NOT NULL AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL AND provider_project_id ~ '^[1-9][0-9]{0,14}$' AND provider_version_id ~ '^[1-9][0-9]{0,14}$')
 OR (origin IN ('hangar','spiget') AND kind='plugin' AND server_id IS NOT NULL AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL)
 OR (origin='github' AND kind='mod' AND server_id IS NOT NULL AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL)
);
