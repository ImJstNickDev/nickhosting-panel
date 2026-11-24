import { promisify } from 'node:util';
import { constants, zstdCompress, zstdDecompress } from 'node:zlib';

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

type Asset = Uint8Array<ArrayBuffer>;
type Entry = { data: Asset; compressed: boolean; length: number; cursor: number; expires: number };

/** One entry per mesh column/LOD or indivisible native surface block/LOD. */
export class OpenworldTerrainHistory {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private compressing = false;
  private expiryTimer?: NodeJS.Timeout;

  constructor(
    private readonly limit: { bytes: number; entries: number; ttl: number },
    private readonly now: () => number,
  ) {}

  forget(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.data.byteLength;
    if (!this.entries.size && this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
  }

  invalidate(matches: (key: string) => boolean) {
    for (const key of this.entries.keys()) if (matches(key)) this.forget(key);
  }

  // LRU order also follows expiry: only remembering or validating moves an entry.
  private discardExpired(now: number) {
    for (const [key, entry] of this.entries) {
      if (entry.expires > now) break;
      this.forget(key);
    }
  }

  private scheduleExpiry() {
    if (this.expiryTimer) return;
    const oldest = this.entries.values().next().value;
    if (!oldest) return;
    // A single wake-up releases idle backing stores even after every viewer leaves.
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined;
        this.discardExpired(this.now());
        this.scheduleExpiry();
      },
      Math.max(1, oldest.expires - this.now()),
    ).unref();
  }

  async remember(key: string, data: Asset, cursor: number) {
    const now = this.now();
    this.discardExpired(now);
    this.forget(key);
    if (data.byteLength > this.limit.bytes) return;
    const entry = {
      data: data.byteLength === data.buffer.byteLength ? data : new Uint8Array(data),
      cursor,
      length: data.byteLength,
      compressed: false,
      expires: now + this.limit.ttl,
    };
    this.entries.set(key, entry);
    this.bytes += data.byteLength;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit.entries && this.bytes <= this.limit.bytes) break;
      this.forget(oldest);
    }
    this.scheduleExpiry();

    // Keep at most one compression in libuv, with no queue and no added latency on delivery.
    if (this.compressing || data.byteLength < 8192) return;
    this.compressing = true;
    try {
      const packed = await compress(data, { params: { [constants.ZSTD_c_compressionLevel]: 1 } });
      if (this.entries.get(key) === entry && packed.byteLength < data.byteLength * 0.85) {
        this.bytes += packed.byteLength - entry.data.byteLength;
        // zlib can return a short view onto a 64 KiB slab. Retain only the bytes charged.
        entry.data = new Uint8Array(packed);
        entry.compressed = true;
      }
    } catch {
      // The bounded raw entry remains usable if compression is unavailable.
    } finally {
      this.compressing = false;
    }
  }

  async restore(
    key: string,
    validate: (since: number) => Promise<number | undefined>,
  ): Promise<Asset | undefined> {
    const now = this.now();
    this.discardExpired(now);
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= now) return;
    const since = entry.cursor;
    const verified = await validate(since);
    if (verified === undefined || verified < since || this.entries.get(key) !== entry) return;
    let data = entry.data;
    if (entry.compressed) {
      try {
        const raw = await decompress(data, { maxOutputLength: entry.length });
        data = raw.byteLength === raw.buffer.byteLength ? raw : new Uint8Array(raw);
      } catch {
        if (this.entries.get(key) === entry) this.forget(key);
        return;
      }
    }
    const completed = this.now();
    if (this.entries.get(key) !== entry || entry.expires <= completed) return;
    // Advance only this asset, and only after the change feed certified its
    // entire footprint. Concurrent validations must never rewind its cursor.
    entry.cursor = Math.max(entry.cursor, verified);
    entry.expires = completed + this.limit.ttl;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return data;
  }
}
