import type { EncryptedSecret, PlatformConfig } from '@nickhosting/core';
import type { GameRolloutState } from '@nickhosting/game-sdk';
import { type ColumnType, type Generated, Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolConfig } from 'pg';
import type { GatewayRouteTables } from './gateway-route-types.js';
import type { GatewayTables } from './gateway-types.js';
import type { HealthTables } from './health-types.js';
import type { AuthTables } from './identity-types.js';
import type { JobTables } from './job-types.js';
import type { MinecraftDatapackTables } from './minecraft-datapack-types.js';
import type { MinecraftMetadataTables } from './minecraft-metadata-types.js';
import type { MinecraftModTables, MinecraftPluginTables } from './minecraft-mod-types.js';
import type { MinecraftModpackTables } from './minecraft-modpack-types.js';
import type { MinecraftSourceTables } from './minecraft-source-types.js';
import type { MinecraftTables } from './minecraft-types.js';
import type { ProviderAccountTables } from './provider-account-types.js';
import type { ProviderFeedTables } from './provider-feed-types.js';
import type { SatisfactoryModTables } from './satisfactory-types.js';
import type { ScheduleTables } from './schedule-types.js';
import type { ServerTables } from './server-types.js';
import type { StoragePolicyTables } from './storage-policy-types.js';

export interface Database
  extends SatisfactoryModTables,
    AuthTables,
    JobTables,
    ServerTables,
    GatewayTables,
    GatewayRouteTables,
    MinecraftTables,
    MinecraftDatapackTables,
    MinecraftModTables,
    MinecraftPluginTables,
    MinecraftModpackTables,
    MinecraftMetadataTables,
    MinecraftSourceTables,
    ScheduleTables,
    HealthTables,
    ProviderFeedTables,
    ProviderAccountTables,
    StoragePolicyTables {
  viewer_sftp_credentials: {
    id: string;
    server_id: string;
    binding: string;
    envelope: EncryptedSecret;
    expires_at: Date;
    status: 'pending' | 'ready' | 'revoked' | 'retired';
    external_user_id: number | null;
    created_at: Generated<Date>;
  };
  file_viewer_preferences: {
    user_id: string;
    scope: 'server' | 'game' | 'global';
    scope_id: string;
    extension: string;
    viewer_id: string;
  };
  platform_settings: {
    key: string;
    value: Partial<PlatformConfig>;
    updated_at: Generated<Date>;
  };
  openworld_release_catalog: {
    runtime: 'dedicated-linux-x64';
    credential_hash: string;
    source: 'metiva' | 'official';
    releases: ColumnType<{ version: string; size: number; sha256: string }[], string, string>;
    sync_order: string;
    synced_at: Date;
  };
  openworld_server_profiles: {
    dashboard_credential_prepared: Generated<boolean>;
    server_id: string;
    version: string;
    sha256: string;
    size: number;
  };
  openworld_capture_cursors: {
    server_id: string;
    next_scan_at: Date;
    lease: string;
    binding: string | null;
    process_ref: string | null;
    evidence: ColumnType<unknown, string | null, string | null>;
  };
  openworld_capture_owners: {
    server_id: string;
    binding: string;
    file_name: string;
    file_bytes: string;
    mtime_ms: string;
    process_ref: string;
    account_id: string | null;
    connection_id: string;
    request_id: string;
    requested_seq: string;
    written_seq: string;
  };
  openworld_player_directories: {
    server_id: string;
    binding: string;
    indexed_at: Date;
    indexing: boolean;
  };
  openworld_player_skins: {
    server_id: string;
    account_id: string;
    binding: string;
    skin_hash: string;
    observed_at: Date;
    head_png: Buffer;
    body_png: Buffer;
  };
  openworld_saved_players: {
    server_id: string;
    file_stem: string;
    revision: string;
    account_id: string | null;
    display_name: string | null;
    saved_at: Date | null;
    last_seen_at: Date | null;
  };
  openworld_telemetry_snapshots: {
    server_id: string;
    resource: 'status' | 'players' | 'history' | 'chunks' | 'storage';
    binding: string;
    observed_at: Date;
    data: ColumnType<unknown, string, string>;
  };
  satisfactory_server_state: {
    server_id: string;
    snapshot: Record<string, unknown>;
    updated_at: Generated<Date>;
  };
  encrypted_secrets: {
    name: string;
    envelope: EncryptedSecret;
    updated_at: Generated<Date>;
  };
  game_integrations: {
    id: string;
    version: string;
    manifest: unknown;
    updated_at: Generated<Date>;
  };
  game_rollouts: {
    integration_id: string;
    state: GameRolloutState;
    allowlist: string[];
    updated_at: Generated<Date>;
  };
}

export function createDatabase(
  connectionString: string,
  options: Omit<PoolConfig, 'connectionString'> = {},
) {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    ...options,
  });
  pool.on('error', () =>
    process.stderr.write(
      `${JSON.stringify({ level: 'error', event: 'database.connection_lost' })}\n`,
    ),
  );
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

export type { GatewayServerState, GatewayTables } from './gateway-types.js';
export * from './job-notifications.js';
export { migrate } from './migrate.js';
export type { ScheduleAction, ScheduleTiming } from './schedule-types.js';
export type { HostSnapshot, ServerLimits } from './server-types.js';
export * from './settings.js';
export * from './storage-policy.js';
export type { StoragePolicy, StoragePolicyTables } from './storage-policy-types.js';
