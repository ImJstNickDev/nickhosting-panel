-- Preparation has no game effects. Publication records dispatch before each effect.
ALTER TABLE minecraft_server_profiles ADD COLUMN runtime_image_transition jsonb NOT NULL DEFAULT 'null';
CREATE TABLE minecraft_modpack_operations (
 id uuid PRIMARY KEY,
 server_id uuid NOT NULL REFERENCES managed_servers(id),
 actor_user_id text NOT NULL REFERENCES "user"(id),
 actor_session_id text NOT NULL,
 subject_user_id text NOT NULL REFERENCES "user"(id),
 support_session_id text,
 resource_owner_id text NOT NULL REFERENCES "user"(id),
 physical_host_id uuid REFERENCES physical_hosts(id),
 held_bytes bigint NOT NULL DEFAULT 0 CHECK(held_bytes >= 0),
 staging_root text,
 idempotency_key text NOT NULL,
 selection jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','preparing','ready','blocked','apply_queued','applying','applied','failed','uncertain','cancelled')),
 phase text NOT NULL DEFAULT 'queued',
 progress jsonb NOT NULL DEFAULT 'null',
 prepared jsonb NOT NULL DEFAULT 'null',
 plan jsonb NOT NULL DEFAULT 'null',
 plan_digest text,
 blockers jsonb NOT NULL DEFAULT '[]',
 apply_request jsonb NOT NULL DEFAULT 'null',
 apply_actor_user_id text REFERENCES "user"(id),
 apply_actor_session_id text,
 apply_subject_user_id text REFERENCES "user"(id),
 apply_support_session_id text,
 apply_idempotency_key text,
 journal jsonb NOT NULL DEFAULT '[]',
 publication jsonb NOT NULL DEFAULT 'null',
 runtime_transition jsonb NOT NULL DEFAULT 'null',
 backup_id text,
 restart_required boolean NOT NULL DEFAULT false,
 error text,
 lease_token uuid,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(server_id,actor_user_id,idempotency_key),
 UNIQUE(server_id,apply_actor_user_id,apply_idempotency_key)
);
CREATE UNIQUE INDEX minecraft_modpack_active ON minecraft_modpack_operations(server_id)
 WHERE state IN ('queued','preparing','ready','apply_queued','applying','uncertain');
CREATE INDEX minecraft_modpack_work ON minecraft_modpack_operations(state,updated_at)
 WHERE state IN ('queued','preparing','apply_queued','applying');
CREATE TABLE minecraft_modpack_receipts (
 server_id uuid PRIMARY KEY REFERENCES managed_servers(id),
 operation_id uuid NOT NULL REFERENCES minecraft_modpack_operations(id),
 receipt jsonb NOT NULL,
 installed_at timestamptz NOT NULL DEFAULT now()
);
