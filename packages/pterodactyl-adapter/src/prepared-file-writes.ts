import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PrivateTransferCache, PterodactylOptions } from './adapter.js';
import type { TransferSettings } from './download-pool.js';
import { allowedOrigin, signedTarget } from './downloads.js';
import { type createTransport, relativePath, segment, validatedBaseURL } from './transport.js';

const EARLY_EXPIRY_MS = 30_000;
const MAX_TTL_MS = 960_000;
const MAX_PENDING = 64;
const pendingByCache = new WeakMap<PrivateTransferCache, Map<string, Promise<void>>>();
let pendingCount = 0;
const grantSchema = z.strictObject({
  url: z.string().min(1).max(8192),
  expiresAt: z.number().int().positive(),
});
type Grant = z.infer<typeof grantSchema>;

/** Optional preparation only: the encrypted store is the sole grant owner.
 * A failed/ambiguous cache operation never releases a local copy for upload. */
export function createPreparedFileWrites(
  options: PterodactylOptions,
  transport: ReturnType<typeof createTransport>,
  settings: (identifier: string) => Promise<TransferSettings>,
) {
  const cache = options.transferCache;
  const origins = new Set(
    (options.uploadOrigins ?? []).map((origin) => allowedOrigin(origin, ['http:', 'https:'])),
  );
  const identity = createHash('sha256')
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
  const keyFor = (identifier: string, path: string) => {
    const server = segment(identifier);
    const exactPath = relativePath(path);
    return `text-write-v1:${identity}:${createHash('sha256')
      .update(JSON.stringify([server, exactPath]))
      .digest('hex')}`;
  };
  const valid = (input: unknown): Grant | undefined => {
    const result = grantSchema.safeParse(input);
    if (!result.success) return;
    const grant = result.data;
    if (
      grant.expiresAt <= Date.now() + EARLY_EXPIRY_MS ||
      grant.expiresAt > Date.now() + MAX_TTL_MS
    )
      return;
    try {
      const target = signedTarget(grant.url, origins);
      if (
        !target.pathname.endsWith('/upload/file') ||
        target.searchParams.getAll('token').length !== 1 ||
        !target.searchParams.get('token')
      )
        return;
      return grant;
    } catch {
      return;
    }
  };
  async function prepare(identifier: string, path: string): Promise<void> {
    const key = keyFor(identifier, path);
    if (!cache || !origins.size) return;
    let pending = pendingByCache.get(cache);
    if (!pending) {
      pending = new Map();
      pendingByCache.set(cache, pending);
    }
    const existing = pending.get(key);
    if (existing) return existing;
    if (pendingCount >= MAX_PENDING) return;
    pendingCount++;
    const work = (async () => {
      const current = await cache.get(key);
      if (current && valid(JSON.parse(current))) return;
      await settings(identifier);
      const result = await transport.json(
        'client',
        `extensions/nickhosting/servers/${segment(identifier)}/upload-urls`,
        z.strictObject({
          expiresAt: z.string().datetime({ offset: true }),
          urls: z.array(z.string().min(1).max(8192)).length(1),
        }),
        'POST',
        { count: 1 },
      );
      const grant = valid({ url: result.urls[0], expiresAt: Date.parse(result.expiresAt) });
      if (!grant) return;
      await cache.put(key, JSON.stringify(grant), grant.expiresAt - Date.now() - EARLY_EXPIRY_MS);
    })()
      // Preparation cannot block the existing Panel write when the extension or
      // transient store is unavailable. No file mutation has happened here.
      .catch(() => {})
      .finally(() => {
        pending.delete(key);
        pendingCount--;
      });
    pending.set(key, work);
    return work;
  }
  async function take(identifier: string, path: string): Promise<Grant | undefined> {
    const key = keyFor(identifier, path);
    if (!cache || !origins.size) return;
    try {
      // Never wait for preparation or issue a credential on the write path.
      const current = await cache.take(key);
      return current ? valid(JSON.parse(current)) : undefined;
    } catch {
      // A token may have been removed before a lost reply. Discard it; only
      // a positively consumed token can select the direct upload path.
      return;
    }
  }
  return { prepare, take };
}
