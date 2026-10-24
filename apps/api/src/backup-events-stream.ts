import type { Pool, PoolClient } from 'pg';

/** One LISTEN connection per API pool while backup pages are open. Durable outcomes live in PG. */
export function createBackupEventStream(pool: Pool) {
  type Subscriber = { serverId: string; changed: () => void; lost: () => void };
  const subscribers = new Set<Subscriber>();
  let client: PoolClient | undefined;
  let connecting: Promise<void> | undefined;
  let channel = '';
  function close() {
    const old = client;
    client = undefined;
    if (!old) return;
    old.removeListener('notification', notification);
    old.removeListener('error', failed);
    old.removeListener('end', failed);
    old.release(true);
  }
  function failed() {
    close();
    for (const item of [...subscribers]) item.lost();
  }
  function notification(event: { channel: string; payload?: string }) {
    if (event.channel !== channel) return;
    for (const item of subscribers) if (event.payload === item.serverId) item.changed();
  }
  async function connect() {
    const next = await pool.connect();
    if (!subscribers.size) {
      next.release();
      return;
    }
    client = next;
    next.on('notification', notification);
    next.on('error', failed);
    next.on('end', failed);
    try {
      const row = await next.query<{ channel: string }>(
        "select 'nh_backups_' || md5(current_database() || ':' || current_schema()) as channel",
      );
      channel = row.rows[0]?.channel ?? '';
      if (!/^nh_backups_[a-f0-9]{32}$/.test(channel)) throw new Error('Invalid event channel');
      await next.query(`LISTEN "${channel}"`);
    } catch (error) {
      close();
      throw error;
    }
  }
  return {
    async subscribe(serverId: string, changed: () => void, lost: () => void) {
      const item = { serverId, changed, lost };
      subscribers.add(item);
      try {
        if (!client && !connecting)
          connecting = connect().finally(() => {
            connecting = undefined;
          });
        if (connecting) await connecting;
      } catch (error) {
        subscribers.delete(item);
        throw error;
      }
      return () => {
        subscribers.delete(item);
        if (!subscribers.size) close();
      };
    },
  };
}
