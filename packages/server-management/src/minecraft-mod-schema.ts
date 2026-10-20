import type { Database } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';

const checks = new WeakMap<object, { expires: number; result: Promise<boolean> }>();
/** HMR can load source before the explicitly approved migration; unrelated features keep working. */
export function minecraftModSchemaAvailable(db: Kysely<Database>): Promise<boolean> {
  const old = checks.get(db);
  if (old && old.expires > Date.now()) return old.result;
  const entry = { expires: Date.now() + 5000, result: Promise.resolve(false) };
  entry.result = sql<{
    present: boolean;
  }>`select to_regclass(current_schema() || '.minecraft_mod_drafts') is not null as present`
    .execute(db)
    .then((result) => {
      const present = result.rows[0]?.present === true;
      if (present) entry.expires = Infinity;
      return present;
    });
  checks.set(db, entry);
  return entry.result;
}
