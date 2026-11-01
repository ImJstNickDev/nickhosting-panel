import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';

const checks = new WeakMap<object, { until: number; value: Promise<boolean> }>();
export function minecraftModpackSchemaAvailable(db: Kysely<Database>): Promise<boolean> {
  const old = checks.get(db);
  if (old && old.until > Date.now()) return old.value;
  const next = { until: Date.now() + 5000, value: Promise.resolve(false) };
  next.value = sql<{
    present: boolean;
  }>`select to_regclass(current_schema() || '.minecraft_modpack_operations') is not null as present`
    .execute(db)
    .then((result) => {
      const present = result.rows[0]?.present === true;
      if (present) next.until = Infinity;
      return present;
    });
  checks.set(db, next);
  return next.value;
}
/** Explicit Install owns the server from admission; preview-only preparation does not. */
export async function assertNoModpackPublication(db: Kysely<Database>, serverId: string) {
  if (!(await minecraftModpackSchemaAvailable(db))) return;
  const row = await db
    .selectFrom('minecraft_modpack_operations')
    .select('id')
    .where('server_id', '=', serverId)
    .where((eb) =>
      eb.or([
        eb('state', 'in', ['apply_queued', 'applying', 'uncertain']),
        eb.and([
          eb('state', 'in', ['queued', 'preparing']),
          sql<boolean>`jsonb_typeof(selection->'install') = 'object'`,
        ]),
      ]),
    )
    .executeTakeFirst();
  if (row) throw new DomainError('operation_busy');
}
