import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { validateTransportOptions } from './transport.js';

// Use the Redis clock across processes. Background observations leave the last
// five percent of the observed minute budget for interactive and lifecycle work.
const admit = `
local pause = redis.call('PTTL', KEYS[1])
if pause > 0 then return pause end
local limit = tonumber(redis.call('GET', KEYS[2]))
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - 60000)
local used = redis.call('ZCARD', KEYS[3])
local reserve = limit and math.min(limit - 1, math.max(1, math.floor(limit / 20)))
if limit and ARGV[1] == 'background' and used >= limit - reserve then
  local eligible = redis.call('ZRANGE', KEYS[3], used - (limit - reserve), used - (limit - reserve), 'WITHSCORES')
  return math.max(1, tonumber(eligible[2]) + 60000 - now)
end
local maxItems = limit or 10000
if used >= maxItems then redis.call('ZREMRANGEBYRANK', KEYS[3], 0, used - maxItems) end
redis.call('ZADD', KEYS[3], now, ARGV[2])
redis.call('PEXPIRE', KEYS[3], 61000)
return 0
`;
const observe = `
if tonumber(ARGV[1]) > redis.call('PTTL', KEYS[1]) and tonumber(ARGV[1]) > 0 then
  redis.call('SET', KEYS[1], 1, 'PX', ARGV[1])
end
if tonumber(ARGV[2]) > 0 then redis.call('SET', KEYS[2], ARGV[2], 'PX', 180000) end
return 0
`;

/** Redis only coordinates outbound traffic. On loss, provider ACLs and
 * throttling still apply, including the adapter's in-process cooldown. */
export function createProviderRequestBudget(redisUrl: string, prefix: string) {
  validateTransportOptions({ redisUrl, prefix });
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    connectTimeout: 300,
    commandTimeout: 300,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on('error', () => {});
  let connecting: Promise<void> | undefined;
  let retryAt = 0;
  let closed = false;
  async function run(binding: string, script: string, ...args: Array<string | number>) {
    if (closed || Date.now() < retryAt) return 0;
    const key = `${prefix}:provider-budget:{${binding}}`;
    try {
      if (client.status !== 'ready') {
        connecting ??= client.connect().finally(() => {
          connecting = undefined;
        });
        await connecting;
      }
      const value = await client.eval(
        script,
        3,
        `${key}:cooldown`,
        `${key}:limit`,
        `${key}:window`,
        ...args,
      );
      return Number(value);
    } catch {
      retryAt = Date.now() + 2000;
      return 0;
    }
  }
  return {
    acquire(binding: string, background: boolean) {
      return run(binding, admit, background ? 'background' : 'foreground', randomUUID());
    },
    async observe(binding: string, limit: number, cooldownMs: number) {
      await run(binding, observe, cooldownMs, limit);
    },
    close() {
      closed = true;
      client.disconnect();
    },
  };
}
