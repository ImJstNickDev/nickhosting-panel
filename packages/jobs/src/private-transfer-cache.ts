import { createHash } from 'node:crypto';
import { type createLogger, DomainError, type SecretCodec } from '@nickhosting/core';
import { Redis } from 'ioredis';
import { validateTransportOptions } from './transport.js';

/** Opaque private payloads only; consumers supply their own versioned schemas and bindings. */
export interface PrivateTransferCache {
  get(key: string): Promise<string | undefined>;
  take(key: string): Promise<string | undefined>;
  put(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}
type Client = Pick<Redis, 'eval' | 'connect' | 'disconnect' | 'on' | 'status'>;
const MAX_TTL_MS = 960_000;
const MAX_ENTRIES = 10_000;
const MAX_BYTES = 64 * 1024 ** 2;

// Every operation, including accounting and expiry cleanup, is atomic. Values have
// native Redis TTLs; the bounded index only accounts for entries already expired.
const operation = `
local index, sizes, total = KEYS[2], KEYS[3], KEYS[4]
local now = redis.call('TIME')
local milliseconds = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local function forget(key)
  local bytes = tonumber(redis.call('HGET', sizes, key) or '0')
  redis.call('DEL', key)
  redis.call('ZREM', index, key)
  redis.call('HDEL', sizes, key)
  if bytes > 0 then redis.call('DECRBY', total, bytes) end
end
for _, key in ipairs(redis.call('ZRANGEBYSCORE', index, '-inf', milliseconds)) do
  forget(key)
end
if ARGV[1] == 'put' then
  local previous = tonumber(redis.call('HGET', sizes, KEYS[1]) or '0')
  local bytes = string.len(ARGV[2])
  local count = redis.call('ZCARD', index)
  local used = tonumber(redis.call('GET', total) or '0')
  if (previous == 0 and count >= tonumber(ARGV[4])) or used - previous + bytes > tonumber(ARGV[5]) then
    return 0
  end
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  redis.call('ZADD', index, milliseconds + tonumber(ARGV[3]), KEYS[1])
  redis.call('HSET', sizes, KEYS[1], bytes)
  redis.call('INCRBY', total, bytes - previous)
  for _, key in ipairs({index, sizes, total}) do redis.call('PEXPIRE', key, ARGV[6]) end
  return 1
end
if ARGV[1] == 'delete' then
  forget(KEYS[1])
  return 1
end
if ARGV[1] == 'take' then
  local value = redis.call('GETDEL', KEYS[1])
  forget(KEYS[1])
  return value
end
return redis.call('GET', KEYS[1])
`;

/** One lazy connection per process, using the existing job Redis. No migrations,
 * queue deliveries, plaintext values, or raw Redis errors leave this boundary. */
export function createPrivateTransferCache(options: {
  redisUrl: string;
  prefix: string;
  databaseUrl: string;
  codec: SecretCodec;
  logger?: ReturnType<typeof createLogger>;
  /** Isolated command fixtures; production callers leave this absent. */
  client?: Client;
}): PrivateTransferCache & { close(): Promise<void> } {
  validateTransportOptions(options);
  if (!options.databaseUrl) throw new DomainError('configuration_invalid');
  // Includes DB connection options such as search_path; deployments sharing Redis
  // cannot share grants across database/schema, job namespace or key contexts.
  const namespace = `${options.prefix}:private-transfer-v1:{${createHash('sha256')
    .update(JSON.stringify([options.prefix, options.databaseUrl]))
    .digest('hex')}}`;
  const client =
    options.client ??
    new Redis(options.redisUrl, {
      lazyConnect: true,
      connectTimeout: 1000,
      commandTimeout: 1000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      retryStrategy: () => null,
    });
  client.on('error', () => options.logger?.log('warn', 'transfers.cache_unavailable'));
  let connecting: Promise<void> | undefined;
  let closed = false;
  const failure = () => new DomainError('integration_unavailable');
  function keyFor(key: string) {
    if (!key || Buffer.byteLength(key) > 4096) throw new DomainError('validation_failed');
    return `${namespace}:${createHash('sha256').update(key).digest('hex')}`;
  }
  async function execute(
    kind: 'get' | 'take' | 'put' | 'delete',
    key: string,
    value = '',
    ttl = 0,
  ) {
    try {
      if (closed) throw failure();
      if (client.status !== 'ready') {
        connecting ??= client.connect().finally(() => {
          connecting = undefined;
        });
        await connecting;
      }
      if (closed) throw failure();
      return await client.eval(
        operation,
        4,
        key,
        `${namespace}:index`,
        `${namespace}:sizes`,
        `${namespace}:bytes`,
        kind,
        value,
        ttl,
        MAX_ENTRIES,
        MAX_BYTES,
        MAX_TTL_MS,
      );
    } catch {
      throw failure();
    }
  }
  async function read(kind: 'get' | 'take', key: string) {
    const privateKey = keyFor(key);
    const value = await execute(kind, privateKey);
    if (value === null || value === undefined) return undefined;
    try {
      if (typeof value !== 'string' || Buffer.byteLength(value) > 1_400_000) throw failure();
      return options.codec.decrypt(JSON.parse(value), privateKey);
    } catch {
      throw failure();
    }
  }
  return {
    get: (key) => read('get', key),
    take: (key) => read('take', key),
    async put(key, value, ttlMs) {
      const privateKey = keyFor(key);
      if (
        !Number.isSafeInteger(ttlMs) ||
        ttlMs < 1 ||
        ttlMs > MAX_TTL_MS ||
        typeof value !== 'string' ||
        !value ||
        Buffer.byteLength(value) > 1_048_576
      )
        throw new DomainError('validation_failed');
      const encrypted = JSON.stringify(options.codec.encrypt(value, privateKey));
      if ((await execute('put', privateKey, encrypted, ttlMs)) !== 1) throw failure();
    },
    async delete(key) {
      await execute('delete', keyFor(key));
    },
    async close() {
      closed = true;
      client.disconnect();
    },
  };
}
