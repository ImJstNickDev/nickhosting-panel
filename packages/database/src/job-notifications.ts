import { type Kysely, sql } from 'kysely';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';

export interface JobNotificationPool {
  connect(): Promise<PoolClient>;
}
const channelSql = (kind: 'jobs' | 'gateway') =>
  `'nh_${kind}_' || md5(current_database() || ':' || current_schema())`;

/** PostgreSQL delivers this hint only on commit. The durable outbox remains authority. */
export async function notifyJobOutbox(db: Kysely<Database>): Promise<void> {
  await sql`select pg_notify(${sql.raw(channelSql('jobs'))}, '')`.execute(db);
}

/** Dedicated, schema-scoped LISTEN connection. No job IDs or credentials in payloads.
 * A disconnected listener is discarded; the worker's fallback poll reconnects it. */
export async function listenForJobOutbox(
  pool: JobNotificationPool,
  wake: () => void,
  disconnected: () => void,
): Promise<{ close(): void }> {
  return listenForChanges(pool, wake, disconnected, 'jobs');
}

/** Commit-only hint: consumers must read the durable current route proof. */
export async function notifyGatewayChange(db: Kysely<Database>): Promise<void> {
  await sql`select pg_notify(${sql.raw(channelSql('gateway'))}, '')`.execute(db);
}

export async function listenForGatewayChanges(
  pool: JobNotificationPool,
  wake: () => void,
  disconnected: () => void,
): Promise<{ close(): void }> {
  return listenForChanges(pool, wake, disconnected, 'gateway');
}

async function listenForChanges(
  pool: JobNotificationPool,
  wake: () => void,
  disconnected: () => void,
  kind: 'jobs' | 'gateway',
): Promise<{ close(): void }> {
  let client: PoolClient | undefined;
  let closed = false;
  let channel: string | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    if (!client) return;
    client.removeListener('notification', notification);
    client.removeListener('error', lost);
    client.removeListener('end', lost);
    // Never return a connection still LISTENing to the ordinary query pool.
    client.release(true);
  };
  const lost = () => {
    if (closed) return;
    close();
    disconnected();
  };
  const notification = (message: { channel: string }) => {
    if (!closed && message.channel === channel) wake();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setup = async () => {
    const acquired = await pool.connect();
    if (closed) {
      acquired.release(true);
      throw new Error('Job listener setup expired');
    }
    client = acquired;
    client.on('error', lost);
    client.on('end', lost);
    client.on('notification', notification);
    const result = await client.query<{ channel: string }>(`select ${channelSql(kind)} as channel`);
    channel = result.rows[0]?.channel;
    if (closed || !channel || !new RegExp(`^nh_${kind}_[a-f0-9]{32}$`).test(channel))
      throw new Error('Job notification listener unavailable');
    await client.query(`LISTEN "${channel}"`);
    if (closed) throw new Error('Job notification listener unavailable');
    return { close };
  };
  try {
    return await Promise.race([
      setup(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          close();
          reject(new Error('Job listener setup expired'));
        }, 2000);
      }),
    ]);
  } catch (error) {
    close();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
