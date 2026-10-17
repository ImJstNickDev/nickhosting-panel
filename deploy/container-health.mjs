import { createHash } from 'node:crypto';
import { containerEnvironment } from './container-env.mjs';

try {
  const role = process.argv[2];
  if (role === 'web') {
    const response = await fetch('http://127.0.0.1:5173/', {
      headers: { Host: new URL(process.env.NH_PUBLIC_URL).host },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error();
  } else if (role === 'api') {
    if (!(await fetch('http://127.0.0.1:3001/readyz', { signal: AbortSignal.timeout(3000) })).ok)
      throw new Error();
  } else if (role === 'worker') {
    const env = containerEnvironment(process.env);
    const { createDatabase } = await import('../packages/database/src/index.js');
    const { pool } = createDatabase(env.DATABASE_URL);
    try {
      const result = await pool.query(
        "SELECT 1 FROM service_heartbeats WHERE service='worker' AND scope_hash=$1 AND state='running' AND observed_at > clock_timestamp() - interval '30 seconds' LIMIT 1",
        [createHash('sha256').update(env.NH_JOB_PREFIX).digest('hex')],
      );
      if (!result.rowCount) throw new Error();
    } finally {
      // This probe uses Pool directly; the lazy Kysely driver was never initialized.
      await pool.end();
    }
  } else throw new Error();
} catch {
  process.exitCode = 1;
}
