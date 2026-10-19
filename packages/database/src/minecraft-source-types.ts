import type { ColumnType, Generated } from 'kysely';

export interface MinecraftSourceTables {
  minecraft_staging_claims: {
    game_id: Generated<string>;
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
    game_id: Generated<string>;
    id: string;
    actor_user_id: string;
    owner_user_id: string;
    server_id: string | null;
    idempotency_key: string;
    identity_digest: string;
    kind: 'world' | 'modpack' | 'datapack';
    origin: 'upload' | 'modrinth' | 'curseforge';
    declared_bytes: string;
    reserved_bytes: string;
    expected_hashes: ColumnType<unknown, string, string>;
    actual_sha256: string | null;
    /** Private immutable source seal; never accepted from a browser or exposed in DTOs. */
    source_seal: ColumnType<unknown | null, string | null | undefined, string | null>;
    storage_root: string;
    provider_project_id: string | null;
    provider_version_id: string | null;
    state: Generated<'reserved' | 'receiving' | 'ready' | 'uncertain' | 'released'>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
}
