import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FileReadTiming, PrivateTransferCache } from './adapter.js';
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
const cacheIds = new WeakMap<PrivateTransferCache, number>();
const invalidationFences = new WeakMap<PrivateTransferCache, Map<string, Promise<void>>>();
let nextFetcherId = 0;
let nextCacheId = 0;
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

/** Credentials are scoped by digest; one-use grants stay in memory or the injected
 * encrypted store, never in both. All transfers continue through this adapter. */
export function createDownloadPool(
  options: TransportOptions & {
    downloadOrigins?: string[];
    fileDownloadBinding?: string;
    transferCache?: PrivateTransferCache;
  },
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
  const shared = options.transferCache;
  const fences = shared
    ? (invalidationFences.get(shared) ?? new Map<string, Promise<void>>())
    : undefined;
  if (shared && fences) invalidationFences.set(shared, fences);
  let cacheId = shared ? cacheIds.get(shared) : undefined;
  if (shared && !cacheId) {
    cacheId = ++nextCacheId;
    cacheIds.set(shared, cacheId);
  }
  const sharedIdentity = createHash('sha256')
    .update(
      JSON.stringify([
        validatedBaseURL(options.baseURL).href,
        options.applicationKey,
        options.clientKey,
        [...origins].sort(),
        options.fileDownloadBinding,
      ]),
    )
    .digest('hex');
  const identity = JSON.stringify([sharedIdentity, fetcherId, cacheId]);
  const sharedKey = (identifier: string, kind: string) =>
    `download-v1:${sharedIdentity}:${segment(identifier)}:${kind}`;
  const generationKey = (identifier: string) => sharedKey(identifier, 'generation');
  const pathGenerationKey = (identifier: string, path: string) =>
    sharedKey(identifier, `path:${createHash('sha256').update(relativePath(path)).digest('hex')}`);
  const grantKey = (identifier: string, generation: string, path: string) =>
    sharedKey(
      identifier,
      `${generation}:${createHash('sha256').update(relativePath(path)).digest('hex')}`,
    );
  async function generation(identifier: string): Promise<string | undefined> {
    if (!shared) return undefined;
    try {
      await fences?.get(generationKey(identifier));
      const key = generationKey(identifier);
      let value = await shared.get(key);
      if (!value) {
        await shared.put(key, randomUUID(), 960_000);
        value = await shared.get(key);
      }
      return value && /^[a-f0-9-]{36}$/.test(value) ? value : undefined;
    } catch {
      // A failed/ambiguous cache operation never creates local authority for a
      // grant that might also have been published to another process.
      return undefined;
    }
  }
  async function pathGeneration(
    identifier: string,
    path: string,
    version: string,
    memo = new Map<string, Promise<string | undefined>>(),
  ) {
    if (!shared) return undefined;
    try {
      const parts = relativePath(path).slice(1).split('/');
      const epochs: Array<string | undefined> = [];
      for (let offset = 0; offset < parts.length; offset += 32) {
        const chunk = parts.slice(offset, offset + 32).map((_part, index) => {
          const key = pathGenerationKey(identifier, parts.slice(0, offset + index + 1).join('/'));
          let read = memo.get(key);
          if (!read) {
            read = shared.get(key);
            if (memo.size < MAX_SCOPE_TOKENS) memo.set(key, read);
          }
          return read;
        });
        epochs.push(...(await Promise.all(chunk)));
      }
      if (epochs.some((value) => value !== undefined && !/^[a-f0-9-]{36}$/.test(value)))
        return undefined;
      return createHash('sha256')
        .update(JSON.stringify([version, ...epochs]))
        .digest('hex');
    } catch {
      return undefined;
    }
  }
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
  async function settings(
    identifier: string,
    refresh = false,
    timing?: FileReadTiming,
  ): Promise<TransferSettings> {
    const pool = state();
    const key = segment(identifier);
    const existing = pool.settings.get(key);
    if (existing?.pending) {
      const pending = existing.pending;
      return timing ? timing.measure('grant.settings.pendingWait', () => pending) : pending;
    }
    if (!refresh && existing?.value && existing.until > Date.now()) {
      const value = existing.value;
      return timing ? timing.measureSync('grant.settings.cache', () => value) : value;
    }
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
      if (shared && !refresh) {
        try {
          const read = () => shared.get(sharedKey(identifier, 'settings'));
          const cached = timing
            ? await timing.measure('grant.settings.shared', read)
            : await read();
          if (cached) {
            const parsed = settingsSchema.safeParse(JSON.parse(cached));
            if (parsed.success) {
              entry.value = parsed.data;
              entry.until = Date.now() + SETTINGS_TTL_MS;
              return parsed.data;
            }
          }
        } catch {
          /* Optional performance metadata never prevents a provider request. */
        }
      }
      try {
        const request = () =>
          transport.json('client', endpoint(identifier, 'transfer-settings'), settingsSchema);
        value = timing ? await timing.measure('grant.settings.http', request) : await request();
      } catch (error) {
        if (!(error instanceof PterodactylError) || error.reason !== 'not_found') throw error;
        // Older extensions support upload batches with the original defaults.
        value = defaults;
      }
      entry.value = value;
      entry.until = Date.now() + SETTINGS_TTL_MS;
      if (shared)
        await shared
          .put(sharedKey(identifier, 'settings'), JSON.stringify(value), SETTINGS_TTL_MS)
          .catch(() => {});
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
    timing?: FileReadTiming,
  ): Promise<Token[] | null> {
    const pool = state();
    if (pool.unsupportedUntil > Date.now()) return null;
    const config = await settings(identifier, refresh, timing);
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
        const request = () =>
          transport.json(
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
        result = timing ? await timing.measure('grant.issue.http', request) : await request();
      } catch (error) {
        if (error instanceof PterodactylError && error.reason === 'not_found') {
          pool.unsupportedUntil = Date.now() + SETTINGS_TTL_MS;
          return null;
        }
        if (!refresh && error instanceof PterodactylError && error.upstreamStatus === 422) {
          return issue(identifier, paths, true, timing);
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
  async function prefetch(
    identifier: string,
    paths: string[],
    timing?: FileReadTiming,
  ): Promise<void> {
    if (shared) return prefetchShared(identifier, paths, timing);
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
        const pending = current.pending;
        waiting.push(timing ? timing.measure('grant.pendingWait', () => pending) : pending);
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
        false,
        timing,
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
  function storedToken(value: string | undefined, path: string): Token | undefined {
    if (value === undefined) return undefined;
    let token: Token;
    try {
      token = z
        .strictObject({ url: z.string().max(128 * 1024), expiresAt: z.number().int() })
        .parse(JSON.parse(value));
    } catch {
      throw invalid();
    }
    if (token.expiresAt <= Date.now()) return undefined;
    if (
      token.expiresAt > Date.now() + 930_000 ||
      Buffer.byteLength(token.url) > estimatedTokenBytes(path)
    )
      throw invalid();
    target(token.url);
    return token;
  }
  async function prefetchShared(identifier: string, paths: string[], timing?: FileReadTiming) {
    if (!shared) return;
    const normalized = [...new Set(paths.map((path) => relativePath(path).slice(1)))].slice(
      0,
      MAX_SCOPE_TOKENS,
    );
    const version = await generation(identifier);
    if (!version) return;
    const pool = state();
    const requested: Array<{ path: string; key: string; slot: Slot; version?: string }> = [];
    const waiting: Promise<void>[] = [];
    const finished = Promise.withResolvers<void>();
    let estimatedBytes = 0;
    for (const path of normalized) {
      const key = keyFor(identifier, path);
      const current = pool.slots.get(key);
      if (current?.pending) {
        const pending = current.pending;
        waiting.push(timing ? timing.measure('grant.pendingWait', () => pending) : pending);
        continue;
      }
      if (current?.error && current.expiresAt > Date.now()) {
        waiting.push(Promise.reject(current.error));
        continue;
      }
      estimatedBytes += estimatedTokenBytes(path);
      if (estimatedBytes > PREFETCH_BUDGET) break;
      remove(pool, key);
      const slot = reserve(pool, key);
      if (slot) {
        slot.pending = finished.promise;
        requested.push({ path, key, slot });
      }
    }
    if (requested.length) {
      const prepare = async () => {
        const missing: typeof requested = [];
        const markers = new Map<string, Promise<string | undefined>>();
        // Bound outstanding Redis work as well as provider grant batches.
        for (let offset = 0; offset < requested.length; offset += 32) {
          const chunk = requested.slice(offset, offset + 32);
          const cached = await Promise.all(
            chunk.map(async (item) => {
              item.version = await pathGeneration(identifier, item.path, version, markers);
              return item.version
                ? shared.get(grantKey(identifier, item.version, item.path)).catch(() => undefined)
                : undefined;
            }),
          );
          for (let index = 0; index < chunk.length; index++) {
            const item = chunk[index];
            if (item?.version && !storedToken(cached[index], item.path)) missing.push(item);
          }
        }
        const tokens = missing.length
          ? await issue(
              identifier,
              missing.map(({ path }) => path),
              false,
              timing,
            )
          : [];
        for (let offset = 0; offset < missing.length; offset += 32) {
          await Promise.all(
            missing.slice(offset, offset + 32).map(async (item, index) => {
              const token = tokens?.[offset + index];
              if (!token || !item.version || pool.slots.get(item.key) !== item.slot) return;
              const ttl = token.expiresAt - Date.now();
              if (ttl > 0)
                await shared
                  .put(grantKey(identifier, item.version, item.path), JSON.stringify(token), ttl)
                  .catch(() => {});
            }),
          );
        }
      };
      void prepare()
        .then(finished.resolve, (error: unknown) => {
          const safe = error instanceof PterodactylError ? error : invalid();
          for (const { key, slot } of requested) {
            if (pool.slots.get(key) !== slot) continue;
            slot.error = safe;
            slot.expiresAt = Date.now() + Math.max(1000, safe.retryAfterMs ?? 5000);
          }
          finished.reject(safe);
        })
        .finally(() => {
          for (const { key, slot } of requested) {
            slot.pending = undefined;
            if (pool.slots.get(key) === slot && !slot.error) remove(pool, key);
          }
        });
      waiting.push(finished.promise);
    }
    await Promise.all(waiting);
  }
  async function nativeGrant(identifier: string, path: string, timing?: FileReadTiming) {
    const request = () =>
      transport.entity(
        'client',
        `servers/${segment(identifier)}/files/download?file=${encodeURIComponent(relativePath(path))}`,
        z.object({ url: z.string() }),
        'GET',
        undefined,
        false,
      );
    const result = timing ? await timing.measure('grant.fallback', request) : await request();
    target(result.url);
    return result.url;
  }
  async function takeShared(
    identifier: string,
    path: string,
    timing?: FileReadTiming,
  ): Promise<string> {
    const key = keyFor(identifier, path);
    const pool = state();
    const current = pool.slots.get(key);
    if (current?.pending) {
      const pending = current.pending;
      if (timing) await timing.measure('grant.pendingWait', () => pending);
      else await pending;
    }
    if (current?.error && current.expiresAt > Date.now()) throw current.error;
    const serverVersion = await generation(identifier);
    const version = serverVersion
      ? await pathGeneration(identifier, path, serverVersion)
      : undefined;
    const read = () =>
      shared && version
        ? shared.take(grantKey(identifier, version, path)).catch(() => undefined)
        : Promise.resolve(undefined);
    const cached = timing ? await timing.measure('grant.shared.take', read) : await read();
    let token = storedToken(cached, path);
    if (token) {
      timing?.measureSync('grant.ready', () => {});
    } else {
      // Never retry/retain an ambiguously consumed shared grant. A fresh grant
      // belongs only to this reader and is not published to the shared store.
      const tokens = await issue(identifier, [relativePath(path).slice(1)], false, timing);
      if (tokens === null) return nativeGrant(identifier, path, timing);
      token = tokens[0];
      if (!token) throw invalid();
    }
    void prefetchShared(identifier, [path]).catch(() => {});
    return token.url;
  }
  async function take(identifier: string, path: string, timing?: FileReadTiming): Promise<string> {
    if (shared) return takeShared(identifier, path, timing);
    const pool = state();
    const key = keyFor(identifier, path);
    for (;;) {
      const current = pool.slots.get(key);
      if (current?.pending) {
        const pending = current.pending;
        if (timing) await timing.measure('grant.pendingWait', () => pending);
        else await pending;
        continue;
      }
      if (current?.error && current.expiresAt > Date.now()) throw current.error;
      if (current?.token && current.expiresAt > Date.now()) {
        // Reserve synchronously before any competing await.
        if (timing) timing.measureSync('grant.ready', () => remove(pool, key));
        else remove(pool, key);
        // Detached refill must never retain the consuming request's timing collector.
        void prefetch(identifier, [path]).catch(() => {});
        return current.token.url;
      }
      remove(pool, key);
      if (pool.unsupportedUntil > Date.now()) {
        return nativeGrant(identifier, path, timing);
      }
      await prefetch(identifier, [path], timing);
      if (!pool.slots.has(key) && pool.unsupportedUntil <= Date.now())
        throw new PterodactylError('unavailable', 'client', 'rejected');
    }
  }
  function invalidate(identifier: string, paths?: string[]): void {
    const pool = pools.get(identity);
    if (!pool && !shared) return;
    const prefix = `${segment(identifier)}:`;
    const normalized = paths?.map((path) => keyFor(identifier, path));
    if (shared && fences) {
      const key = generationKey(identifier);
      const invalidate = async () => {
        if (!paths) return shared.put(key, randomUUID(), 960_000);
        try {
          for (let offset = 0; offset < paths.length; offset += 32)
            await Promise.all(
              paths
                .slice(offset, offset + 32)
                .map((path) =>
                  shared.put(pathGenerationKey(identifier, path), randomUUID(), 960_000),
                ),
            );
        } catch {
          // A full cache can replace the existing server fence without needing
          // a new slot; scoped invalidation normally preserves unrelated grants.
          await shared.put(key, randomUUID(), 960_000);
        }
      };
      const pending = (fences.get(key) ?? Promise.resolve()).catch(() => {}).then(invalidate);
      fences.set(key, pending);
      void pending
        .finally(() => {
          if (fences.get(key) === pending) fences.delete(key);
        })
        .catch(() => {});
    }
    if (!pool) return;
    for (const key of pool.slots.keys()) {
      if (
        key.startsWith(prefix) &&
        (!normalized || normalized.some((path) => key === path || key.startsWith(`${path}/`)))
      )
        remove(pool, key);
    }
  }
  async function fresh(identifier: string, path: string, timing?: FileReadTiming): Promise<string> {
    // Bypass detached refill and shared cache after a token rejection. Reads are
    // safe to retry once; never obtain the same prepared credential a second time.
    const tokens = await issue(identifier, [relativePath(path).slice(1)], false, timing);
    if (tokens === null) return nativeGrant(identifier, path, timing);
    const token = tokens[0];
    if (!token) throw invalid();
    return token.url;
  }
  return { prefetch, take, fresh, invalidate, settings };
}
