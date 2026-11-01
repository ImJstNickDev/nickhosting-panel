export const thumbnailLimits = {
  intervalMs: 100,
  bucketSeconds: 2,
  entries: 32,
  aliases: 128,
  readBytes: 8 * 1024 * 1024,
  requestMs: 6_000,
};

/** Counts delivered stream bytes, including prefetch, rather than declared Content-Length. */
export class ThumbnailReadBudget {
  private remaining = thumbnailLimits.readBytes;

  reset() {
    this.remaining = thumbnailLimits.readBytes;
  }

  consume(bytes: number) {
    this.remaining -= bytes;
    if (this.remaining < 0) throw new Error('Thumbnail read budget exceeded');
  }
}

export type VideoThumbnail = { src: string; time: number };
export type ThumbnailRequest = {
  type: 'thumbnail';
  url: string;
  size: number;
  bucket: number;
  cachedKeys: number[];
};
export type ThumbnailReply =
  | { type: 'thumbnail'; bucket: number; key: number; time: number; blob?: Blob }
  | { type: 'empty'; bucket: number }
  | { type: 'error' }
  | { type: 'cancelled' };

export function thumbnailBucket(time: number | null) {
  return time !== null && Number.isFinite(time) && time >= 0
    ? Math.floor(time / thumbnailLimits.bucketSeconds) * thumbnailLimits.bucketSeconds
    : undefined;
}

/** One in-flight request, one replaceable wanted bucket, and a bounded keyframe LRU. */
export class ThumbnailSession {
  private wanted: number | undefined;
  private inflight: number | undefined;
  private closed = false;
  private readonly aliases = new Map<number, number | null>();
  private readonly entries = new Map<number, VideoThumbnail>();

  constructor(
    private readonly createUrl = (blob: Blob) => URL.createObjectURL(blob),
    private readonly revokeUrl = (url: string) => URL.revokeObjectURL(url),
  ) {}

  want(time: number | null) {
    this.wanted = thumbnailBucket(time);
  }

  next() {
    if (
      this.closed ||
      this.inflight !== undefined ||
      this.wanted === undefined ||
      this.aliases.has(this.wanted)
    )
      return undefined;
    this.inflight = this.wanted;
    return { bucket: this.inflight, cachedKeys: [...this.entries.keys()] };
  }

  read() {
    if (this.closed || this.wanted === undefined) return undefined;
    const key = this.aliases.get(this.wanted);
    if (key === undefined || key === null) return undefined;
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  complete(reply: Extract<ThumbnailReply, { bucket: number }>) {
    if (this.closed || reply.bucket !== this.inflight) return;
    this.inflight = undefined;
    if (reply.type === 'empty') {
      this.aliases.set(reply.bucket, null);
    } else {
      let entry = this.entries.get(reply.key);
      if (!entry && reply.blob) {
        entry = { src: this.createUrl(reply.blob), time: reply.time };
      }
      if (!entry) return;
      this.entries.delete(reply.key);
      this.entries.set(reply.key, entry);
      this.aliases.set(reply.bucket, reply.key);
    }
    while (this.entries.size > thumbnailLimits.entries) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.revokeUrl(oldest[1].src);
      this.entries.delete(oldest[0]);
      for (const [bucket, key] of this.aliases) {
        if (key === oldest[0]) this.aliases.delete(bucket);
      }
    }
    while (this.aliases.size > thumbnailLimits.aliases) {
      const oldest = this.aliases.keys().next().value;
      if (oldest === undefined) break;
      this.aliases.delete(oldest);
    }
  }

  cancelPending() {
    this.wanted = this.inflight = undefined;
  }

  dispose() {
    this.closed = true;
    this.wanted = this.inflight = undefined;
    for (const entry of this.entries.values()) this.revokeUrl(entry.src);
    this.entries.clear();
    this.aliases.clear();
  }
}
