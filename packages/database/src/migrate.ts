import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const directory = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Serialized, transactional, immutable SQL migrations. No account/data seeding. */
export async function migrate(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':migrations', 0))",
    );
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const known = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const files = (await readdir(directory))
      .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name))
      .sort();
    for (const entry of known.rows) {
      if (!files.includes(entry.name)) throw new Error(`Missing applied migration: ${entry.name}`);
    }
    for (const name of files) {
      const contents = await readFile(`${directory}/${name}`, 'utf8');
      const checksum = createHash('sha256').update(contents).digest('hex');
      const old = known.rows.find((row) => row.name === name);
      if (old) {
        if (old.checksum !== checksum) throw new Error(`Modified applied migration: ${name}`);
        continue;
      }
      await client.query(contents);
      await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [
        name,
        checksum,
      ]);
      applied.push(name);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
