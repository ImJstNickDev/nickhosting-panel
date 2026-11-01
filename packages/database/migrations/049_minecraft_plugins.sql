-- Plugins use the proven JAR publication lifecycle, with isolated drafts and receipts.
ALTER TABLE minecraft_sources DROP CONSTRAINT minecraft_sources_kind_check;
ALTER TABLE minecraft_sources ADD CONSTRAINT minecraft_sources_kind_check CHECK (kind IN ('world','modpack','datapack','mod','plugin'));
ALTER TABLE minecraft_sources DROP CONSTRAINT minecraft_sources_origin_check;
ALTER TABLE minecraft_sources ADD CONSTRAINT minecraft_sources_origin_check CHECK (origin IN ('upload','modrinth','curseforge','hangar','spiget'));
ALTER TABLE minecraft_sources DROP CONSTRAINT minecraft_sources_provider_identity;
ALTER TABLE minecraft_sources ADD CONSTRAINT minecraft_sources_provider_identity CHECK (
 (origin='upload' AND provider_project_id IS NULL AND provider_version_id IS NULL)
 OR (origin='modrinth' AND kind IN ('modpack','datapack','mod','plugin') AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL)
 OR (origin='curseforge' AND kind IN ('world','datapack','mod','plugin') AND server_id IS NOT NULL AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL AND provider_project_id ~ '^[1-9][0-9]{0,14}$' AND provider_version_id ~ '^[1-9][0-9]{0,14}$')
 OR (origin IN ('hangar','spiget') AND kind='plugin' AND server_id IS NOT NULL AND provider_project_id IS NOT NULL AND provider_version_id IS NOT NULL)
);
CREATE TABLE minecraft_plugin_drafts (
 server_id uuid PRIMARY KEY REFERENCES managed_servers(id), revision integer NOT NULL DEFAULT 0,
 actor_user_id text NOT NULL REFERENCES "user"(id), selection jsonb NOT NULL DEFAULT '{}'::jsonb,
 state text NOT NULL CHECK(state IN ('preparing','ready','failed','uncertain')),
 blockers jsonb NOT NULL DEFAULT '[]'::jsonb, optional jsonb NOT NULL DEFAULT '[]'::jsonb,
 error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE minecraft_plugin_changes (
 id uuid PRIMARY KEY, server_id uuid NOT NULL REFERENCES managed_servers(id), revision integer NOT NULL,
 actor_user_id text NOT NULL REFERENCES "user"(id), action text NOT NULL CHECK(action IN ('install','enable','disable','delete')),
 state text NOT NULL CHECK(state IN ('queued','preparing','ready','dispatched','applied','failed','uncertain','cancelled')),
 idempotency_key text NOT NULL, plan jsonb NOT NULL, error text, cleanup_done boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(server_id,actor_user_id,idempotency_key)
);
CREATE INDEX minecraft_plugin_changes_current ON minecraft_plugin_changes(server_id,revision,state);
CREATE TABLE minecraft_plugin_applies (
 id uuid PRIMARY KEY,server_id uuid NOT NULL REFERENCES managed_servers(id),revision integer NOT NULL,
 actor_user_id text NOT NULL REFERENCES "user"(id),idempotency_key text NOT NULL,
 changes jsonb NOT NULL,moves jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('dispatched','published','uncertain','reconciled')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(server_id,actor_user_id,idempotency_key)
);
CREATE TABLE minecraft_plugin_receipts (
 server_id uuid NOT NULL REFERENCES managed_servers(id),path text NOT NULL,receipt jsonb NOT NULL,
 PRIMARY KEY(server_id,path)
);
CREATE TABLE minecraft_plugin_restart (
 server_id uuid PRIMARY KEY REFERENCES managed_servers(id),changed_at timestamptz NOT NULL
);
