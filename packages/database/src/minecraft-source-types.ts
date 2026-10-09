import type { ColumnType, Generated } from 'kysely';

export interface MinecraftSourceTables {
  minecraft_staging_claims: {
    job_id: string;
    server_id: string;
    owner_user_id: string;
    actor_user_id: string;
    reserved_bytes: string;
    storage_root: string;
    identity_digest: string;
    state: Generated<'reserved' | 'released'>;
    created_at: Generated<Date>;
  };
  minecraft_source_bindings: {
    source_id: string;
    server_id: string;
    created_at: Generated<Date>;
  };
  minecraft_sources: {
    id: string;
    actor_user_id: string;
    owner_user_id: string;
    server_id: string | null;
    idempotency_key: string;
    identity_digest: string;
    kind: 'world' | 'modpack';
    origin: 'upload' | 'modrinth';
    declared_bytes: string;
    reserved_bytes: string;
    expected_hashes: ColumnType<unknown, string, string>;
    actual_sha256: string | null;
    storage_root: string;
    provider_project_id: string | null;
    provider_version_id: string | null;
    state: Generated<'reserved' | 'receiving' | 'ready' | 'uncertain' | 'released'>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
}
