import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ViewerCache, type ViewerReadSource } from './viewer-cache.js';
import { openLogViewer } from './viewer-log.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup(text: string, chunk = 65000) {
  const root = await mkdtemp(join(tmpdir(), 'nh-log-'));
  const cache = new ViewerCache({
    root,
    maxBytes: 64 * 1024 * 1024,
    maxFileBytes: 32 * 1024 * 1024,
  });
  cleanups.push(async () => {
    await cache.close();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from(text);
  const stream = vi.fn(
    () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += chunk)
            controller.enqueue(bytes.subarray(i, i + chunk));
          controller.close();
        },
      }),
  );
  const source: ViewerReadSource = {
    size: bytes.length,
    mtimeMs: 1,
    read: async () => {
      throw new Error('no direct read');
    },
    stream,
  };
  return { cache, source, stream };
}
const query = { offset: 0, limit: 2, query: '', level: 'all' as const };
it('indexes UTF-8 chunk boundaries, CRLF, empty lines and final partial lines', async () => {
  const { cache, source } = await setup('\uFEFFfirst\r\n\nLogGame: Warning: città\nlast', 1);
  const session = await openLogViewer(source, { cache, key: 'a' });
  expect(await session.query({ ...query, limit: 10 })).toEqual({
    rows: [
      { line: 1, text: 'first', level: 'info' },
      { line: 2, text: '', level: 'info' },
      { line: 3, text: 'LogGame: Warning: città', level: 'warning' },
      { line: 4, text: 'last', level: 'info' },
    ],
    offset: 0,
    total: 4,
    totalLines: 4,
  });
  await session.close();
});
it('pages actual distant file regions and searches all of a tens-of-MiB snapshot without upstream rereads', async () => {
  const text = Array.from(
    { length: 40_000 },
    (_, i) =>
      `${i === 5 ? 'EARLY needle Error' : i === 39000 ? 'LATE needle Warning' : 'LogGame: Display:'} ${i} ${'x'.repeat(550)}\n`,
  ).join('');
  const { cache, source, stream } = await setup(text);
  const session = await openLogViewer(source, { cache, key: 'large' });
  expect((await session.query({ ...query, offset: 20_000 })).rows.map((r) => r.line)).toEqual([
    20001, 20002,
  ]);
  expect((await session.query({ ...query, offset: -1 })).rows.map((r) => r.line)).toEqual([
    39999, 40000,
  ]);
  const found = await session.query({ ...query, query: 'NeEdLe' });
  expect(found.total).toBe(2);
  expect(found.rows.map((r) => r.line)).toEqual([6, 39001]);
  expect((await session.query({ ...query, query: 'needle', level: 'warning' })).rows[0]?.line).toBe(
    39001,
  );
  const second = await openLogViewer(source, { cache, key: 'large' });
  expect(stream).toHaveBeenCalledTimes(1);
  await second.close();
  await session.close();
});
it('handles empty files and rejects revision changes, invalid UTF-8 and oversized lines', async () => {
  const empty = await setup('');
  const session = await openLogViewer(empty.source, { cache: empty.cache, key: 'empty' });
  expect(await session.query({ ...query, offset: -1 })).toEqual({
    rows: [],
    offset: 0,
    total: 0,
    totalLines: 0,
  });
  await session.close();
  await expect(
    openLogViewer(empty.source, {
      cache: empty.cache,
      key: 'changed',
      restat: async () => ({ size: 2, mtimeMs: 1 }),
    }),
  ).rejects.toMatchObject({ code: 'viewer_revision_changed' });
  const large = await setup('x'.repeat(1024 * 1024 + 1));
  await expect(
    openLogViewer(large.source, { cache: large.cache, key: 'line' }),
  ).rejects.toMatchObject({ code: 'viewer_log_line_too_large' });
  const invalid = await setup('good');
  invalid.source.stream = () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([255, 255, 255, 255]));
        c.close();
      },
    });
  await expect(
    openLogViewer(invalid.source, { cache: invalid.cache, key: 'bad' }),
  ).rejects.toMatchObject({ code: 'viewer_log_encoding' });
});
it('bounds query inputs, cancellation and closed-session access', async () => {
  const { source, cache } = await setup('a\nb\nc\n');
  const session = await openLogViewer(source, { cache, key: 'a' });
  await expect(session.query({ ...query, limit: 501 })).rejects.toMatchObject({
    code: 'viewer_log_query',
  });
  await expect(session.query(query, AbortSignal.abort())).rejects.toBeDefined();
  expect((await session.query({ ...query, offset: 99 })).rows.map((r) => r.line)).toEqual([3]);
  await session.close();
  await session.close();
  await expect(session.query(query)).rejects.toBeDefined();
});
it('cancels active scans and bounds concurrent scans and response memory', async () => {
  const { source, cache } = await setup('line data\n'.repeat(100_000));
  const session = await openLogViewer(source, { cache, key: 'concurrent' });
  const one = new AbortController(),
    two = new AbortController();
  const first = session.query({ ...query, query: 'absent' }, one.signal);
  const second = session.query({ ...query, query: 'absent' }, two.signal);
  await expect(session.query({ ...query, query: 'absent' })).rejects.toMatchObject({
    code: 'viewer_cache_busy',
  });
  one.abort();
  two.abort();
  await expect(first).rejects.toBeDefined();
  await expect(second).rejects.toBeDefined();
  await session.close();
  const huge = await setup(`${'x'.repeat(800_000)}\n`.repeat(3));
  const large = await openLogViewer(huge.source, { cache: huge.cache, key: 'page' });
  await expect(large.query({ ...query, limit: 3 })).rejects.toMatchObject({
    code: 'viewer_log_budget',
  });
  await large.close();
});
