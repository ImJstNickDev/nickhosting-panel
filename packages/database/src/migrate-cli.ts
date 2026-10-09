import { createDatabase, migrate } from './index.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(process.env.DATABASE_URL);
try {
  const names = await migrate(pool);
  console.info(JSON.stringify({ event: 'migrations.completed', applied: names }));
} finally {
  await db.destroy();
}
