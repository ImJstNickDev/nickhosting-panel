import { createHash } from 'node:crypto';
import { z } from 'zod';
import { allowedOrigin, signedTarget } from './downloads.js';
import {
  type createTransport,
  PterodactylError,
  relativePath,
  segment,
  type TransportOptions,
  validatedBaseURL,
} from './transport.js';

const settingsSchema = z.strictObject({
  downloadBatchLimit: z.number().int().min(1).max(2500),
  uploadBatchLimit: z.number().int().min(1).max(500),
  signedUrlTtlSeconds: z.number().int().min(60).max(900),
});
export type TransferSettings = z.infer<typeof settingsSchema>;
const defaults: TransferSettings = {
  downloadBatchLimit: 2500,
  uploadBatchLimit: 500,
  signedUrlTtlSeconds: 900,
};
interface Token {
  url: string;
  expiresAt: number;
}
interface Slot {
  bytes: number;
  token?: Token;
  pending?: Promise<void>;
  error?: PterodactylError;
  expiresAt: number;
}
interface Pool {
  reservedBytes: number;
  slots: Map<string, Slot>;
  settings: Map<
    string,
    { value?: TransferSettings; pending?: Promise<TransferSettings>; until: number }
  >;
  unsupportedUntil: number;
}
const pools = new Map<string, Pool>();
const fetcherIds = new WeakMap<typeof fetch, number>();
let nextFetcherId = 0;
const MAX_SCOPES = 64;
const MAX_TOKENS = 10_000;
const MAX_SCOPE_TOKENS = 5000;
const EARLY_EXPIRY_MS = 30_000;
const SETTINGS_TTL_MS = 60_000;
const RESPONSE_BUDGET = 3 * 1024 * 1024;
const PREFETCH_BUDGET = 16 * 1024 * 1024;
const MAX_POOL_BYTES = 64 * 1024 * 1024;
// PHP JSON unicode escaping + base64 JWT expansion, plus fixed claims/signature/URL.
const estimatedTokenBytes = (path: string) => Buffer.byteLength(path) * 4 + 2048;
const invalid = () => new PterodactylError('invalid_response', 'client', 'rejected');

/** Private process memory only. Digests scope credentials; tokens never escape the adapter. */
export function createDownloadPool(
  options: TransportOptions & { downloadOrigins?: string[]; fileDownloadBinding?: string },
  transport: ReturnType<typeof createTransport>,
) {
  const fetcher = options.fetcher ?? fetch;
  let fetcherId = fetcherIds.get(fetcher);
  if (!fetcherId) {
    fetcherId = ++nextFetcherId;
    fetcherIds.set(fetcher, fetcherId);
  }
  const origins = new Set([
    validatedBaseURL(options.baseURL).origin,
    ...(options.downloadOrigins ?? []).map((origin) => allowedOrigin(origin, ['http:', 'https:'])),
  ]);
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        validatedBaseURL(options.baseURL).href,
        options.applicationKey,
        options.clientKey,
        [...origins].sort(),
        options.fileDownloadBinding,
        fetcherId,
      ]),
    )
    .digest('hex');
  function state(): Pool {
    const existing = pools.get(identity);
    if (existing) {
      pools.delete(identity);
      pools.set(identity, existing);
      return existing;
    }
    if (pools.size >= MAX_SCOPES) {
      for (const [key, pool] of pools) {
        if (![...pool.slots.values()].some((slot) => slot.pending)) {
          pools.delete(key);
          break;
        }
      }
    }
    if (pools.size >= MAX_SCOPES) throw new PterodactylError('unavailable', 'client', 'rejected');
    const pool: Pool = {
      slots: new Map(),
      settings: new Map(),
      unsupportedUntil: 0,
      reservedBytes: 0,
    };
    pools.set(identity, pool);
    return pool;
  }
  function remove(pool: Pool, key: string): void {
    const previous = pool.slots.get(key);
    if (previous) {
      pool.reservedBytes -= previous.bytes;
      pool.slots.delete(key);
    }
  }
  function reserve(pool: Pool, key: string): Slot | undefined {
    let count = [...pools.values()].reduce((sum, current) => sum + current.slots.size, 0);
    const bytes = estimatedTokenBytes(key);
    let totalBytes = [...pools.values()].reduce((sum, current) => sum + current.reservedBytes, 0);
    if (
      pool.slots.size >= MAX_SCOPE_TOKENS ||
      count >= MAX_TOKENS ||
      totalBytes + bytes > MAX_POOL_BYTES
    ) {
      for (const current of pool.slots.size >= MAX_SCOPE_TOKENS ? [pool] : pools.values()) {
        const entry = [...current.slots].find(([, slot]) => !slot.pending);
        if (entry) {
          remove(current, entry[0]);
          break;
        }
      }
      // All entries may be pending. Refuse speculative work rather than growing without bound.
      count = [...pools.values()].reduce((sum, current) => sum + current.slots.size, 0);
      totalBytes = [...pools.values()].reduce((sum, current) => sum + current.reservedBytes, 0);
      if (
        pool.slots.size >= MAX_SCOPE_TOKENS ||
        count >= MAX_TOKENS ||
        totalBytes + bytes > MAX_POOL_BYTES
      )
        return undefined;
    }
    const slot: Slot = { expiresAt: Number.POSITIVE_INFINITY, bytes };
    pool.reservedBytes += bytes;
    pool.slots.set(key, slot);
    return slot;
  }
  const keyFor = (identifier: string, path: string) =>
    `${segment(identifier)}:${relativePath(path)}`;
  const endpoint = (identifier: string, method: string) =>
    `extensions/nickhosting/servers/${segment(identifier)}/${method}`;
  async function settings(identifier: string, refresh = false): Promise<TransferSettings> {
    const pool = state();
    const key = segment(identifier);
    const existing = pool.settings.get(key);
    if (existing?.pending) return existing.pending;
    if (!refresh && existing?.value && existing.until > Date.now()) return existing.value;
    if (pool.settings.size >= 256 && !existing) {
      const victim = [...pool.settings].find(([, value]) => !value.pending);
      if (victim) pool.settings.delete(victim[0]);
      else throw new PterodactylError('unavailable', 'client', 'rejected');
    }
    const entry: { value?: TransferSettings; pending?: Promise<TransferSettings>; until: number } =
      { until: 0 };
    pool.settings.set(key, entry);
    entry.pending = (async () => {
      let value: TransferSettings;
      try {
        value = await transport.json(
          'client',
          endpoint(identifier, 'transfer-settings'),
          settingsSchema,
        );
      } catch (error) {
        if (!(error instanceof PterodactylError) || error.reason !== 'not_found') throw error;
        // Older extensions support upload batches with the original defaults.
        value = defaults;
      }
      entry.value = value;
      entry.until = Date.now() + SETTINGS_TTL_MS;
      return value;
    })().finally(() => {
      entry.pending = undefined;
    });
    return entry.pending;
  }
  function target(value: string): URL {
    const url = signedTarget(value, origins);
    if (
      !url.pathname.endsWith('/download/file') ||
      url.searchParams.getAll('token').length !== 1 ||
      !url.searchParams.get('token')
    )
      throw invalid();
    return url;
  }
  async function issue(
    identifier: string,
    paths: string[],
    refresh = false,
  ): Promise<Token[] | null> {
    const pool = state();
    if (pool.unsupportedUntil > Date.now()) return null;
    const config = await settings(identifier, refresh);
    const tokens: Token[] = [];
    const seen = new Set<string | null>();
    for (let offset = 0; offset < paths.length; ) {
      const chunk: string[] = [];
      let bytes = 0;
      while (offset < paths.length && chunk.length < config.downloadBatchLimit) {
        const path = paths[offset];
        if (path === undefined) break;
        const estimate = estimatedTokenBytes(path);
        if (chunk.length > 0 && bytes + estimate > RESPONSE_BUDGET) break;
        chunk.push(path);
        bytes += estimate;
        offset++;
      }
      const startedAt = Date.now();
      let result: { urls: string[]; expiresAt: string };
      try {
        result = await transport.json(
          'client',
          endpoint(identifier, 'download-urls'),
          z.strictObject({
            expiresAt: z.string().datetime({ offset: true }),
            urls: z
              .array(
                z
                  .string()
                  .min(1)
                  .max(128 * 1024),
              )
              .length(chunk.length),
          }),
          'POST',
          { paths: chunk },
        );
      } catch (error) {
        if (error instanceof PterodactylError && error.reason === 'not_found') {
          pool.unsupportedUntil = Date.now() + SETTINGS_TTL_MS;
          return null;
        }
        if (!refresh && error instanceof PterodactylError && error.upstreamStatus === 422) {
          return issue(identifier, paths, true);
        }
        throw error;
      }
      const expiresAt = Date.parse(result.expiresAt) - EARLY_EXPIRY_MS;
      if (expiresAt <= Date.now() || expiresAt > startedAt + 900_000 + 60_000 - EARLY_EXPIRY_MS)
        throw invalid();
      for (const url of result.urls) {
        const token = target(url).searchParams.get('token');
        if (seen.has(token)) throw invalid();
        seen.add(token);
        const path = chunk[tokens.length - (offset - chunk.length)];
        if (path === undefined || Buffer.byteLength(url) > estimatedTokenBytes(path))
          throw invalid();
        tokens.push({ url, expiresAt });
      }
    }
    return tokens;
  }
  async function prefetch(identifier: string, paths: string[]): Promise<void> {
    const pool = state();
    for (const current of pools.values()) {
      for (const [key, slot] of current.slots) {
        if (!slot.pending && slot.expiresAt <= Date.now()) remove(current, key);
      }
    }
    // Bounded speculative cache. Uncached files are issued on demand.
    const normalized = [...new Set(paths.map((path) => relativePath(path).slice(1)))].slice(
      0,
      MAX_SCOPE_TOKENS,
    );
    const requested: Array<{ path: string; key: string; slot: Slot }> = [];
    const waiting: Promise<void>[] = [];
    let estimatedBytes = 0;
    for (const path of normalized) {
      const key = keyFor(identifier, path);
      const current = pool.slots.get(key);
      if (current?.pending) {
        waiting.push(current.pending);
        continue;
      }
      if (current && current.expiresAt > Date.now()) {
        if (current.error) waiting.push(Promise.reject(current.error));
        continue;
      }
      estimatedBytes += estimatedTokenBytes(path);
      if (estimatedBytes > PREFETCH_BUDGET) break;
      remove(pool, key);
      const slot = reserve(pool, key);
      if (slot) requested.push({ path, key, slot });
    }
    if (requested.length) {
      const pending = issue(
        identifier,
        requested.map(({ path }) => path),
      )
        .then((tokens) => {
          for (let i = 0; i < requested.length; i++) {
            const item = requested[i];
            if (!item) continue;
            if (pool.slots.get(item.key) !== item.slot) continue;
            const token = tokens?.[i];
            if (!token) remove(pool, item.key);
            else {
              item.slot.token = token;
              item.slot.expiresAt = token.expiresAt;
            }
          }
        })
        .catch((error: unknown) => {
          const safe = error instanceof PterodactylError ? error : invalid();
          for (const { key, slot } of requested) {
            if (pool.slots.get(key) !== slot) continue;
            slot.error = safe;
            slot.expiresAt = Date.now() + Math.max(1000, safe.retryAfterMs ?? 5000);
          }
          throw safe;
        })
        .finally(() => {
          for (const { slot } of requested) slot.pending = undefined;
        });
      for (const { slot } of requested) slot.pending = pending;
      waiting.push(pending);
    }
    await Promise.all(waiting);
  }
  async function take(identifier: string, path: string): Promise<string> {
    const pool = state();
    const key = keyFor(identifier, path);
    for (;;) {
      const current = pool.slots.get(key);
      if (current?.pending) {
        await current.pending;
        continue;
      }
      if (current?.error && current.expiresAt > Date.now()) throw current.error;
      if (current?.token && current.expiresAt > Date.now()) {
        remove(pool, key); // Reserve synchronously before any competing await.
        void prefetch(identifier, [path]).catch(() => {});
        return current.token.url;
      }
      remove(pool, key);
      if (pool.unsupportedUntil > Date.now()) {
        const result = await transport.entity(
          'client',
          `servers/${segment(identifier)}/files/download?file=${encodeURIComponent(relativePath(path))}`,
          z.object({ url: z.string() }),
          'GET',
          undefined,
          false,
        );
        target(result.url);
        return result.url;
      }
      await prefetch(identifier, [path]);
      if (!pool.slots.has(key) && pool.unsupportedUntil <= Date.now())
        throw new PterodactylError('unavailable', 'client', 'rejected');
    }
  }
  function invalidate(identifier: string, paths?: string[]): void {
    const pool = pools.get(identity);
    if (!pool) return;
    const prefix = `${segment(identifier)}:`;
    const normalized = paths?.map((path) => keyFor(identifier, path));
    for (const key of pool.slots.keys()) {
      if (
        key.startsWith(prefix) &&
        (!normalized || normalized.some((path) => key === path || key.startsWith(`${path}/`)))
      )
        remove(pool, key);
    }
  }
  return { prefetch, take, invalidate, settings };
}
