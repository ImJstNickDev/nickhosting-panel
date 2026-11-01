import type { Database } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';

const modChecks = new WeakMap<object, { expires: number; result: Promise<boolean> }>();
const pluginChecks: typeof modChecks = new WeakMap();
/** HMR can load source before the explicitly approved migration; unrelated features keep working. */
export function minecraftModSchemaAvailable(
  db: Kysely<Database>,
  kind: 'mod' | 'plugin' = 'mod',
): Promise<boolean> {
  const checks = kind === 'plugin' ? pluginChecks : modChecks;
  const table = kind === 'plugin' ? '.minecraft_plugin_drafts' : '.minecraft_mod_drafts';
  const old = checks.get(db);
  if (old && old.expires > Date.now()) return old.result;
  const entry = { expires: Date.now() + 5000, result: Promise.resolve(false) };
  entry.result = sql<{
    present: boolean;
  }>`select to_regclass(current_schema() || ${table}) is not null as present`
    .execute(db)
    .then((result) => {
      const present = result.rows[0]?.present === true;
      if (present) entry.expires = Infinity;
      return present;
    });
  checks.set(db, entry);
  return entry.result;
}
