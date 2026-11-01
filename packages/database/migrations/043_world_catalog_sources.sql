-- Extend source provenance; existing uploads, seals and reservations are unchanged.
ALTER TABLE minecraft_sources
  DROP CONSTRAINT minecraft_sources_origin_check,
  DROP CONSTRAINT minecraft_sources_check2;

ALTER TABLE minecraft_sources
  ADD CONSTRAINT minecraft_sources_origin_check
    CHECK (origin IN ('upload', 'modrinth', 'curseforge')),
  ADD CONSTRAINT minecraft_sources_provider_identity
    CHECK (
      (origin = 'upload' AND provider_project_id IS NULL AND provider_version_id IS NULL)
      OR (origin = 'modrinth' AND kind = 'modpack'
        AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL)
      OR (origin = 'curseforge' AND kind = 'world' AND server_id IS NOT NULL
        AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL
        AND provider_project_id ~ '^[1-9][0-9]{0,14}$'
        AND provider_version_id ~ '^[1-9][0-9]{0,14}$')
    );
