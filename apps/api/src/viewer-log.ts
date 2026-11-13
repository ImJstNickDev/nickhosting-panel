import { createReadStream } from 'node:fs';
import { type ViewerCache, ViewerFormatError, type ViewerReadSource } from './viewer-cache.js';

export type ViewerLogLevel = 'error' | 'warning' | 'info';
export type ViewerLogRow = { line: number; text: string; level: ViewerLogLevel };
export type ViewerLogQuery = {
  offset: number;
  limit: number;
  query: string;
  level: 'all' | ViewerLogLevel;
};
export type ViewerLogPage = {
  rows: ViewerLogRow[];
  offset: number;
  total: number;
  totalLines: number;
};
export interface ViewerLogSession {
  query(options: ViewerLogQuery, signal?: AbortSignal): Promise<ViewerLogPage>;
  close(): Promise<void>;
}
const maximumLineBytes = 1024 * 1024;
const maximumLines = 10_000_000;
const stride = 128;
const maximumPageCharacters = 2 * 1024 * 1024;
const classify = (text: string): ViewerLogLevel =>
  /\b(?:error|fatal)\b/i.test(text) ? 'error' : /\bwarning\b/i.test(text) ? 'warning' : 'info';

/** A bounded immutable snapshot, shared with the normal viewer disk cache. */
export async function openLogViewer(
  source: ViewerReadSource,
  options: {
    cache: ViewerCache;
    key: string;
    signal?: AbortSignal;
    restat?: () => Promise<{ size: number; mtimeMs: number }>;
  },
): Promise<ViewerLogSession> {
  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([lifetime.signal, options.signal])
    : lifetime.signal;
  const lease = await options.cache.acquire(`${options.key}:log`, source, signal);
  let released = false;
  const close = async () => {
    if (released) return;
    released = true;
    lifetime.abort();
    lease.release();
    await options.cache.discardIdle(`${options.key}:log`);
  };
  const anchors: number[] = [];
  let totalLines = 0;
  async function* lines(start = 0, first = 1, requestSignal = signal) {
    const stream = createReadStream(lease.path, {
      start,
      highWaterMark: 64 * 1024,
      signal: requestSignal,
    });
    let pieces: Buffer[] = [],
      bytes = 0,
      offset = start,
      line = first;
    const decode = (value: Buffer) => {
      if (value.at(-1) === 13) value = value.subarray(0, -1);
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: line !== 1 }).decode(value);
      } catch {
        throw new ViewerFormatError('viewer_log_encoding');
      }
    };
    try {
      for await (const chunk of stream) {
        requestSignal.throwIfAborted();
        const buffer = chunk as Buffer;
        let cursor = 0;
        while (cursor < buffer.length) {
          const end = buffer.indexOf(10, cursor);
          const part = buffer.subarray(cursor, end < 0 ? buffer.length : end);
          bytes += part.length;
          if (bytes > maximumLineBytes) throw new ViewerFormatError('viewer_log_line_too_large');
          pieces.push(part);
          if (end < 0) break;
          const text = decode(Buffer.concat(pieces, bytes));
          yield { line, text, offset };
          offset += bytes + 1;
          line++;
          pieces = [];
          bytes = 0;
          cursor = end + 1;
        }
      }
      if (bytes) yield { line, text: decode(Buffer.concat(pieces, bytes)), offset };
    } finally {
      stream.destroy();
    }
  }
  try {
    const after = await options.restat?.();
    if (after && (after.size !== source.size || after.mtimeMs !== source.mtimeMs))
      throw new ViewerFormatError('viewer_revision_changed');
    for await (const row of lines()) {
      totalLines++;
      if (totalLines > maximumLines) throw new ViewerFormatError('viewer_log_budget');
      if ((row.line - 1) % stride === 0) anchors.push(row.offset);
    }
  } catch (error) {
    await close();
    throw error;
  }
  let active = 0;
  return {
    close,
    async query(input, requestSignal) {
      const combined = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      combined.throwIfAborted();
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < -1 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 500 ||
        typeof input.query !== 'string' ||
        input.query.length > 256 ||
        !['all', 'error', 'warning', 'info'].includes(input.level)
      )
        throw new ViewerFormatError('viewer_log_query');
      if (active >= 2) throw new ViewerFormatError('viewer_cache_busy');
      active++;
      try {
        const filtered = input.query !== '' || input.level !== 'all';
        const lastOffset = (total: number) =>
          Math.max(0, Math.floor((total - 1) / input.limit) * input.limit);
        if (!filtered) {
          const offset =
            input.offset < 0
              ? lastOffset(totalLines)
              : Math.min(input.offset, lastOffset(totalLines));
          if (!totalLines) return { rows: [], offset: 0, total: 0, totalLines };
          const anchor = Math.floor(offset / stride);
          const rows: ViewerLogRow[] = [];
          let pageCharacters = 0;
          for await (const row of lines(anchors[anchor], anchor * stride + 1, combined)) {
            if (row.line <= offset) continue;
            pageCharacters += row.text.length;
            if (pageCharacters > maximumPageCharacters)
              throw new ViewerFormatError('viewer_log_budget');
            rows.push({ line: row.line, text: row.text, level: classify(row.text) });
            if (rows.length === input.limit) break;
          }
          return { rows, offset, total: totalLines, totalLines };
        }
        const needle = input.query.toLowerCase();
        const rows: ViewerLogRow[] = [],
          tail: ViewerLogRow[] = [];
        let total = 0,
          pageCharacters = 0,
          tailCharacters = 0;
        for await (const row of lines(0, 1, combined)) {
          const level = classify(row.text);
          if (
            (input.level !== 'all' && input.level !== level) ||
            !row.text.toLowerCase().includes(needle)
          )
            continue;
          const value = { line: row.line, text: row.text, level };
          if (total >= input.offset && input.offset >= 0 && rows.length < input.limit) {
            pageCharacters += row.text.length;
            if (pageCharacters > maximumPageCharacters)
              throw new ViewerFormatError('viewer_log_budget');
            rows.push(value);
          }
          if (input.offset < 0 || !rows.length) {
            if (total % input.limit === 0) {
              tail.length = 0;
              tailCharacters = 0;
            }
            tailCharacters += row.text.length;
            if (tailCharacters > maximumPageCharacters)
              throw new ViewerFormatError('viewer_log_budget');
            tail.push(value);
          }
          total++;
        }
        const offset = input.offset < 0 || input.offset >= total ? lastOffset(total) : input.offset;
        return {
          rows: input.offset < 0 || input.offset >= total ? tail : rows,
          offset,
          total,
          totalLines,
        };
      } finally {
        active--;
      }
    },
  };
}
