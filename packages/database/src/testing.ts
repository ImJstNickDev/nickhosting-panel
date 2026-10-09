import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDatabase, migrate } from './index.js';

/** Never falls back to production URLs. Each suite owns only its generated schema. */
export async function createTestDatabase() {
  const value = process.env.NH_TEST_DATABASE_URL;
  if (!value)
    throw new Error('NH_TEST_DATABASE_URL is required; start the approved isolated test project');
  const url = new URL(value);
  if (
    !['127.0.0.1', 'localhost', '[::1]', process.env.NH_TEST_VERIFIED_DATABASE_HOST].includes(
      url.hostname,
    ) ||
    url.pathname !== '/nickhosting_test' ||
    url.username !== 'nickhosting_test'
  ) {
    throw new Error(
      'Integration tests require the isolated local nickhosting_test database and user',
    );
  }
  const schema = `nh_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: value, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const { db, pool } = createDatabase(value, { options: `-c search_path=${schema}`, max: 15 });
  try {
    await migrate(pool);
  } catch (error) {
    await db.destroy();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    throw error;
  }
  return {
    db,
    pool,
    schema,
    async destroy() {
      await db.destroy();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}
