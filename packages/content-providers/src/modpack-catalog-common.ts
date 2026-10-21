import { z } from 'zod';
import { type ContentHttp, fail, safeArchivePath } from './contracts.js';
import type { ModpackCatalogPageInput } from './modpack-catalog.js';
import type { ModpackDownload } from './modpack-recipes.js';

export const str = z.string().max(512 * 1024);
export const strings = z.array(str).max(10000);
export const numericId = z.number().int().positive();
export function identifier(input: string): string {
  if (!/^[A-Za-z0-9_.+ -]{1,256}$/.test(input) || input === '.' || input === '..')
    fail('modpack_identity');
  return encodeURIComponent(input);
}
export function pageInput(input: ModpackCatalogPageInput = {}) {
  return z
    .object({
      offset: z.number().int().min(0).max(9980).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .parse(input);
}
export function queryInput(value = ''): string {
  return z.string().max(256).parse(value).trim();
}
export function slicePage<T>(items: T[], input: ModpackCatalogPageInput = {}) {
  const { offset, limit } = pageInput(input);
  return { items: items.slice(offset, offset + limit), offset, limit, total: items.length };
}
export function publicUrl(input: string | null | undefined): string | undefined {
  if (!input || input.length > 2048) return undefined;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
export function downloadUrl(input: string): string {
  const url = publicUrl(input);
  if (!url?.startsWith('https:') || new URL(url).hash) fail('modpack_download_url');
  return url;
}
export function download(input: ModpackDownload): ModpackDownload {
  if (input.filename.includes('/') || input.filename.includes('\\')) fail('modpack_filename');
  safeArchivePath(input.filename);
  if (input.size !== undefined && (!Number.isSafeInteger(input.size) || input.size < 0))
    fail('modpack_size');
  if (!input.urls.length || input.urls.length > 8) fail('modpack_download_url');
  const lengths: Record<string, number> = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };
  for (const [name, value] of Object.entries(input.hashes))
    if (
      !lengths[name] ||
      typeof value !== 'string' ||
      value.length !== lengths[name] ||
      !/^[a-f0-9]+$/.test(value)
    )
      fail('modpack_hash');
  return { ...input, urls: input.urls.map(downloadUrl) };
}
export function published(input?: string | number): string | undefined {
  if (input === undefined) return undefined;
  const date = new Date(typeof input === 'number' ? input * 1000 : input);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}
export function providerChannel(value?: string | number): 'release' | 'beta' | 'alpha' | 'unknown' {
  const channel = String(value).toLowerCase();
  return ['release', 'stable', '1'].includes(channel)
    ? 'release'
    : ['beta', '2'].includes(channel)
      ? 'beta'
      : ['alpha', '3'].includes(channel)
        ? 'alpha'
        : 'unknown';
}

/** Per-adapter cache: shared across screens/jobs by the service, bounded by bytes and entries. */
export class ModpackMetadataCache {
  private readonly values = new Map<string, { value: unknown; until: number; bytes: number }>();
  private bytes = 0;
  private readonly pending = new Map<string, { signal?: AbortSignal; promise: Promise<unknown> }>();
  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly budget = 16 * 1024 ** 2,
  ) {}
  async get<T>(key: string, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.values.get(key);
    if (previous && previous.until > Date.now()) return structuredClone(previous.value) as T;
    if (previous) {
      this.bytes -= previous.bytes;
      this.values.delete(key);
    }
    const active = this.pending.get(key);
    if (active && active.signal === signal) return structuredClone(await active.promise) as T;
    const promise = read();
    this.pending.set(key, { signal, promise });
    let value: T;
    try {
      value = await promise;
    } finally {
      if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
    }
    signal?.throwIfAborted();
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? '');
    if (bytes <= this.budget) {
      const current = this.values.get(key);
      if (current) {
        this.bytes -= current.bytes;
        this.values.delete(key);
      }
      while (this.bytes + bytes > this.budget || this.values.size >= 128) {
        const first = this.values.entries().next().value;
        if (!first) break;
        this.bytes -= first[1].bytes;
        this.values.delete(first[0]);
      }
      this.values.set(key, {
        value: structuredClone(value),
        until: Date.now() + this.ttlMs,
        bytes,
      });
      this.bytes += bytes;
    }
    return value;
  }
}
export class ModpackMetadataClient {
  readonly cache = new ModpackMetadataCache();
  constructor(readonly http: ContentHttp) {}
  json(url: string, signal?: AbortSignal) {
    return this.cache.get(url, () => this.http.json(url, { signal }), signal);
  }
  text(url: string, signal?: AbortSignal) {
    return this.cache.get(
      url,
      () => {
        if (!this.http.text) fail('modpack_text_transport');
        return this.http.text(url, { signal });
      },
      signal,
    );
  }
}
