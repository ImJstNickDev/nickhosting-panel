import { randomUUID } from 'node:crypto';
import type { createDatabase } from '@nickhosting/database';

/** Confirm a synthetic DNS name only inside the isolated browser-test database. */
export async function confirmConsoleFixtureAddress(
  db: ReturnType<typeof createDatabase>['db'],
  serverId: string,
) {
  const allocation = await db
    .selectFrom('server_allocations')
    .select('direct_endpoint')
    .where('server_id', '=', serverId)
    .where('is_primary', '=', true)
    .executeTakeFirstOrThrow();
  const port = allocation.direct_endpoint?.port;
  if (!port) throw new Error('Console fixture primary direct endpoint is missing');
  const hostname = 'console.example.test';
  await db
    .insertInto('dns_assignments')
    .values({
      id: randomUUID(),
      server_id: serverId,
      hostname,
      ownership_token: randomUUID(),
      state: 'active',
      ledger: JSON.stringify([]),
      plan: JSON.stringify({
        connection: { hostname, port, displayAddress: `${hostname}:${port}`, records: [] },
      }),
    })
    .execute();
}
