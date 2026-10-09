import type { EncryptedSecret, PlatformConfig } from '@nickhosting/core';
import type { GameRolloutState } from '@nickhosting/game-sdk';
import { type Generated, Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolConfig } from 'pg';
import type { GatewayRouteTables } from './gateway-route-types.js';
import type { GatewayTables } from './gateway-types.js';
import type { AuthTables } from './identity-types.js';
import type { JobTables } from './job-types.js';
import type { MinecraftSourceTables } from './minecraft-source-types.js';
import type { MinecraftTables } from './minecraft-types.js';
import type { ServerTables } from './server-types.js';

export interface Database
  extends AuthTables,
    JobTables,
    ServerTables,
    GatewayTables,
    GatewayRouteTables,
    MinecraftTables,
    MinecraftSourceTables {
  platform_settings: {
    key: string;
    value: Partial<PlatformConfig>;
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
export { migrate } from './migrate.js';
export type { HostSnapshot, ServerLimits } from './server-types.js';
export * from './settings.js';
