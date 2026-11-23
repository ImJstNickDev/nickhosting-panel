import { promisify } from 'node:util';
import { constants, zstdCompress, zstdDecompress } from 'node:zlib';

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

type Asset = Uint8Array<ArrayBuffer>;
type Entry = { data: Asset; compressed: boolean; length: number; cursor: number; expires: number };

/** Process-local geometry for revisits. A live change cursor is required on every restore. */
export class OpenworldTerrainHistory {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private compressing = false;

  constructor(
    private readonly limit: { bytes: number; entries: number; ttl: number },
    private readonly now: () => number,
  ) {}

  forget(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.data.byteLength;
  }

  invalidate(matches: (key: string) => boolean) {
    for (const key of this.entries.keys()) if (matches(key)) this.forget(key);
  }

  async remember(key: string, data: Asset, cursor: number) {
    this.forget(key);
    if (data.byteLength > this.limit.bytes) return;
    const entry = {
      data,
      cursor,
      length: data.byteLength,
      compressed: false,
      expires: this.now() + this.limit.ttl,
    };
    this.entries.set(key, entry);
    this.bytes += data.byteLength;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit.entries && this.bytes <= this.limit.bytes) break;
      this.forget(oldest);
    }

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
    unchanged: (since: number) => Promise<boolean>,
  ): Promise<Asset | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= this.now()) {
      this.forget(key);
      return;
    }
    if (!(await unchanged(entry.cursor)) || this.entries.get(key) !== entry) return;
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
    if (this.entries.get(key) !== entry || entry.expires <= this.now()) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return data;
  }
}
