import { DomainError } from '@nickhosting/core';
import {
  MatroskaSubtitles,
  type SubtitleByteReader,
  type SubtitleWindow,
} from '../../../packages/core/src/media-subtitles.js';
import { ViewerFormatError, type ViewerReadSource } from './viewer-cache.js';

const prefixBytes = 1024;
const coalescedBytes = 512 * 1024;
const maximumReadAheadBytes = 24 * 1024 * 1024;
const nearbyGapBytes = 16 * 1024;
const cacheBytes = 2 * 1024 * 1024;

/** Coalesce nearby metadata reads; distant media payloads still use small prefixes.
 * The parser keeps its 8 MiB demand budget. Read-ahead has a separate, bounded
 * allowance, then falls back to small reads without failing a valid sparse scan.
 */
export class SubtitleMetadataReader implements SubtitleByteReader {
  #chunks = new Map<number, Uint8Array<ArrayBuffer>>();
  #bytes = 0;
  #budget = 0;
  #readAheadBudget = 0;
  #generation = 0;
  #lastRequestedEnd: number | undefined;
  #recent: { start: number; bytes: Uint8Array<ArrayBuffer> } | undefined;
  constructor(
    readonly source: ViewerReadSource,
    readonly signal: AbortSignal,
    readonly lifetime: AbortSignal,
  ) {}
  resetBudget(bytes: number) {
    this.#budget = bytes;
    this.#readAheadBudget = Math.min(maximumReadAheadBytes, bytes * 3);
  }
  clear() {
    this.#generation++;
    this.#chunks.clear();
    this.#bytes = 0;
    this.#recent = undefined;
    this.#lastRequestedEnd = undefined;
  }
  async read(start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted();
    this.lifetime.throwIfAborted();
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.source.size
    )
      throw new ViewerFormatError('viewer_subtitles_unavailable');
    if (start === end) return new Uint8Array();
    const previousEnd = this.#lastRequestedEnd;
    this.#lastRequestedEnd = end;
    const hit = (offset: number, bytes: Uint8Array<ArrayBuffer>) =>
      start >= offset && end <= offset + bytes.length;
    if (this.#recent && hit(this.#recent.start, this.#recent.bytes))
      return this.#recent.bytes.subarray(start - this.#recent.start, end - this.#recent.start);
    for (const [offset, bytes] of this.#chunks) {
      if (!hit(offset, bytes)) continue;
      this.#chunks.delete(offset);
      this.#chunks.set(offset, bytes);
      this.#recent = { start: offset, bytes };
      return bytes.subarray(start - offset, end - offset);
    }
    const required = Math.min(this.source.size - start, Math.max(prefixBytes, end - start));
    if (required > this.#budget) throw new ViewerFormatError('viewer_subtitles_unavailable');
    // Judge locality by the parser's requested bytes, not by speculative chunk
    // boundaries: a large skipped video packet is never mistaken for dense text.
    const nearby =
      previousEnd === undefined || (start >= previousEnd && start - previousEnd <= nearbyGapBytes);
    const length = Math.min(
      this.source.size - start,
      Math.max(
        required,
        Math.min(nearby ? coalescedBytes : prefixBytes, required + this.#readAheadBudget),
      ),
    );
    this.#budget -= required;
    this.#readAheadBudget -= length - required;
    const generation = this.#generation;
    const aborted = Promise.withResolvers<never>();
    const onAbort = () =>
      aborted.reject(this.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    this.signal.addEventListener('abort', onAbort, { once: true });
    try {
      this.signal.throwIfAborted();
      // Request cancellation must not close the retained SFTP handle used by the
      // next window. Authorization/session revocation still cancels the actual I/O.
      const read = await Promise.race([
        this.source.read(start, length, this.lifetime),
        aborted.promise,
      ]);
      this.signal.throwIfAborted();
      this.lifetime.throwIfAborted();
      if (read.byteLength !== length) throw new DomainError('conflict');
      const bytes = new Uint8Array(read);
      if (generation === this.#generation && bytes.length <= cacheBytes) {
        const previous = this.#chunks.get(start);
        if (previous) this.#bytes -= previous.length;
        this.#chunks.delete(start);
        this.#chunks.set(start, bytes);
        this.#bytes += bytes.length;
        while (this.#bytes > cacheBytes) {
          const oldest = this.#chunks.entries().next().value;
          if (!oldest) break;
          this.#chunks.delete(oldest[0]);
          this.#bytes -= oldest[1].length;
        }
        this.#recent = { start, bytes };
      }
      return bytes.subarray(0, end - start);
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
  }
}

export type SubtitleViewerSession = {
  readWindow(track: string, time: number, signal?: AbortSignal): Promise<SubtitleWindow>;
  close(): void;
};

export async function createSubtitleViewer(
  source: ViewerReadSource,
  options: { signal: AbortSignal },
): Promise<SubtitleViewerSession> {
  const parser = new MatroskaSubtitles(
    source.size,
    (signal) => new SubtitleMetadataReader(source, signal, options.signal),
    options.signal,
  );
  const failed = (error: unknown, signal?: AbortSignal): never => {
    if (options.signal.aborted) throw new DomainError('forbidden');
    signal?.throwIfAborted();
    if (error instanceof DomainError || error instanceof ViewerFormatError) throw error;
    throw new ViewerFormatError('viewer_subtitles_unavailable');
  };
  try {
    if (!(await parser.open())) throw new ViewerFormatError('viewer_subtitles_unavailable');
  } catch (error) {
    parser.dispose();
    failed(error);
  }
  return {
    async readWindow(track, time, signal) {
      try {
        return await parser.readWindow(track, time, signal);
      } catch (error) {
        return failed(error, signal);
      }
    },
    close() {
      parser.dispose();
    },
  };
}
