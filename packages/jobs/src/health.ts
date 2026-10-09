import { Redis } from 'ioredis';

/** Read-only PING: no BullMQ queue, key writes, reconnect loop or raw errors. */
export async function probeRedis(
  redisUrl: string | undefined,
): Promise<'healthy' | 'unconfigured' | 'unavailable'> {
  if (!redisUrl) return 'unconfigured';
  try {
    const parsed = new URL(redisUrl);
    if (!['redis:', 'rediss:'].includes(parsed.protocol) || parsed.hash) return 'unavailable';
  } catch {
    return 'unavailable';
  }
  const connection = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 1500,
    commandTimeout: 1500,
    maxRetriesPerRequest: 0,
    retryStrategy: null,
    enableOfflineQueue: false,
    enableReadyCheck: false,
  });
  connection.on('error', () => {});
  try {
    await connection.connect();
    return (await connection.ping()) === 'PONG' ? 'healthy' : 'unavailable';
  } catch {
    return 'unavailable';
  } finally {
    connection.disconnect();
  }
}
