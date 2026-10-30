-- Datapack preparation is separate from publication. Dispatch fences survive
-- process interruption; uncertain changes are never automatically replayed.
ALTER TABLE minecraft_sources DROP CONSTRAINT minecraft_sources_kind_check;
ALTER TABLE minecraft_sources ADD CONSTRAINT minecraft_sources_kind_check
 CHECK (kind IN ('world', 'modpack', 'datapack'));
ALTER TABLE minecraft_sources DROP CONSTRAINT minecraft_sources_provider_identity;
ALTER TABLE minecraft_sources ADD CONSTRAINT minecraft_sources_provider_identity CHECK (
 (origin = 'upload' AND provider_project_id IS NULL AND provider_version_id IS NULL)
 OR (origin = 'modrinth' AND kind IN ('modpack','datapack') AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL)
 OR (origin = 'curseforge' AND kind IN ('world','datapack') AND server_id IS NOT NULL
 AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL
 AND provider_project_id ~ '^[1-9][0-9]{0,14}$' AND provider_version_id ~ '^[1-9][0-9]{0,14}$')
);
CREATE TABLE minecraft_datapack_changes (
 id uuid PRIMARY KEY,
 server_id uuid NOT NULL REFERENCES managed_servers(id),
 actor_user_id text NOT NULL REFERENCES "user"(id),
 world text NOT NULL,
 name text NOT NULL,
 action text NOT NULL CHECK (action IN ('install','enable','disable','delete')),
 state text NOT NULL CHECK (state IN ('preparing','ready','dispatched','applied','failed','uncertain','cancelled')),
 idempotency_key text NOT NULL,
 source_id uuid REFERENCES minecraft_sources(id),
 plan jsonb NOT NULL,
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (server_id, actor_user_id, idempotency_key)
);
CREATE UNIQUE INDEX minecraft_datapack_pending_path ON minecraft_datapack_changes(server_id, world, name)
 WHERE state IN ('preparing','ready','dispatched','uncertain');
CREATE INDEX minecraft_datapack_changes_inventory ON minecraft_datapack_changes(server_id, world, created_at);
CREATE TABLE minecraft_datapack_applies (
 id uuid PRIMARY KEY,
 server_id uuid NOT NULL REFERENCES managed_servers(id),
 actor_user_id text NOT NULL REFERENCES "user"(id),
 world text NOT NULL,
 idempotency_key text NOT NULL,
 changes jsonb NOT NULL,
 state text NOT NULL CHECK (state IN ('dispatched','published','uncertain','reconciled')),
 cleanup jsonb NOT NULL DEFAULT '[]'::jsonb,
 cleanup_state text NOT NULL DEFAULT 'complete' CHECK (cleanup_state IN ('pending','complete','failed')),
 reload text NOT NULL CHECK (reload IN ('not_required','required','requested','uncertain')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (server_id, actor_user_id, idempotency_key)
);
