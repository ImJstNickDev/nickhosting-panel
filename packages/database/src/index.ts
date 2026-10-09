import type { EncryptedSecret, PlatformConfig } from '@nickhosting/core';
import type { GameRolloutState } from '@nickhosting/game-sdk';
import { type Generated, Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolConfig } from 'pg';
import type { AuthTables } from './identity-types.js';
import type { JobTables } from './job-types.js';

export interface Database extends AuthTables, JobTables {
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

export { migrate } from './migrate.js';
export * from './settings.js';
