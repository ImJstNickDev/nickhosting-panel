import { describe, expect, it, vi } from 'vitest';
import type { ViewerReadSource } from './viewer-cache.js';
import { createSubtitleViewer, SubtitleMetadataReader } from './viewer-subtitles.js';

/** Sparse original Matroska fixture: 1 GiB of skipped video, not allocated in RAM. */
function unindexedMovie(payload = 1024 * 1024, count = 1000) {
  const number = (value: number, width = Math.max(1, Math.ceil(Math.log2(value + 1) / 8))) => {
    const buffer = Buffer.alloc(width);
    buffer.writeUIntBE(value, 0, width);
    return buffer;
  };
  const header = (id: number, length: number) => {
    let width = 1;
    while (length >= 2 ** (7 * width) - 1) width++;
    const size = number(length, width);
    size[0] = (size[0] ?? 0) | (1 << (8 - width));
    return Buffer.concat([number(id), size]);
  };
  const element = (id: number, ...parts: Uint8Array[]) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([header(id, body.length), body]);
  };
  const metadata = element(0x1a45dfa3, element(0x4282, Buffer.from('matroska')));
  const tracks = element(
    0x1654ae6b,
    element(
      0xae,
      element(0xd7, number(2)),
      element(0x83, number(17)),
      element(0x86, Buffer.from('S_TEXT/UTF8')),
    ),
  );
  const timestamp = element(0xe7, number(0));
  const cue = element(
    0xa0,
    element(0xa1, Buffer.from([0x82, 0x03, 0xe8, 0]), Buffer.from('Subtitle after skipped video')),
    element(0x9b, number(3000)),
  );
  const block = Buffer.concat([header(0xa3, payload + 4), Buffer.from([0x81, 0, 0, 0])]);
  const cluster = header(
    0x1f43b675,
    timestamp.length + count * (block.length + payload) + cue.length,
  );
  const segment = header(
    0x18538067,
    tracks.length +
      cluster.length +
      timestamp.length +
      count * (block.length + payload) +
      cue.length,
  );
  const spans: { start: number; bytes: Buffer }[] = [];
  let size = 0;
  const add = (bytes: Buffer) => {
    spans.push({ start: size, bytes });
    size += bytes.length;
  };
  add(Buffer.concat([metadata, segment, tracks, cluster, timestamp]));
  for (let index = 0; index < count; index++) {
    add(block);
    size += payload;
  }
  add(cue);
  let transferred = 0;
  let reads = 0;
  const source: ViewerReadSource = {
    size,
    mtimeMs: 1,
    async read(start, length) {
      transferred += length;
      reads++;
      const bytes = Buffer.alloc(length);
      for (const span of spans) {
        const begin = Math.max(start, span.start),
          end = Math.min(start + length, span.start + span.bytes.length);
        if (end > begin)
          span.bytes.copy(bytes, begin - start, begin - span.start, end - span.start);
      }
      return bytes;
    },
    stream: () => {
      throw new Error('No full movie download');
    },
  };
  return { source, transferred: () => transferred, reads: () => reads };
}

function fixture() {
  const read = vi.fn(async (_offset: number, length: number, _signal?: AbortSignal) =>
    new Uint8Array(length).fill(17),
  );
  const source: ViewerReadSource = {
    size: 4 * 1024 * 1024 * 1024,
    mtimeMs: 1,
    read,
    stream: () => {
      throw new Error('Subtitle metadata must not download the full file');
    },
  };
  const request = new AbortController();
  const lifetime = new AbortController();
  const reader = new SubtitleMetadataReader(source, request.signal, lifetime.signal);
  reader.resetBudget(8 * 1024 * 1024);
  return { source, read, request, lifetime, reader };
}

describe('retained SFTP subtitle metadata reader', () => {
  it('parses an unindexed large movie using bounded metadata reads and reuses its window', async () => {
    const movie = unindexedMovie();
    const viewer = await createSubtitleViewer(movie.source, {
      signal: new AbortController().signal,
    });
    try {
      const window = await viewer.readWindow('2', 2);
      expect(window.cues).toEqual([
        {
          id: expect.any(String),
          start: 1,
          end: 4,
          text: 'Subtitle after skipped video',
          settings: undefined,
        },
      ]);
      expect(movie.transferred()).toBeLessThan(1600 * 1024);
      const bytes = movie.transferred();
      expect(await viewer.readWindow('2', 3)).toBe(window);
      expect(movie.transferred()).toBe(bytes);
    } finally {
      viewer.close();
    }
  });
  it.each([128, 256, 2048])(
    'skips %s KiB media payloads without mistaking prefetched bytes for locality',
    async (payloadKiB) => {
      const { reader, read } = fixture();
      for (let index = 0; index < 1000; index++) {
        const start = index * payloadKiB * 1024;
        expect(await reader.read(start, start + 12)).toHaveLength(12);
        expect(await reader.read(start + 12, start + 20)).toHaveLength(8);
      }
      expect(read.mock.calls.length).toBeGreaterThan(990);
      expect(read.mock.calls.length).toBeLessThanOrEqual(1000);
      // Initial metadata is coalesced; the following large jumps stay sparse.
      expect(read.mock.calls[0]?.[1]).toBe(512 * 1024);
      expect(read.mock.calls.slice(1).every((call) => call[1] === 1024)).toBe(true);
      expect(read.mock.calls.reduce((sum, call) => sum + call[1], 0)).toBeLessThan(1600 * 1024);
    },
  );

  it('limits the byte cache to 2 MiB and charges the budget only for actual SFTP reads', async () => {
    const { reader, read } = fixture();
    const chunk = 512 * 1024;
    for (let index = 0; index < 5; index++) await reader.read(index * chunk, (index + 1) * chunk);
    reader.resetBudget(0);
    await reader.read(4 * chunk, 4 * chunk + 12);
    expect(read).toHaveBeenCalledTimes(5);
    await expect(reader.read(0, 12)).rejects.toThrow('viewer_subtitles_unavailable');
    expect(read).toHaveBeenCalledTimes(5);
    reader.resetBudget(1024);
    await reader.read(0, 12);
    expect(read).toHaveBeenCalledTimes(6);
  });

  it('coalesces many nearby headers and falls back when its read-ahead allowance is spent', async () => {
    const { reader, read } = fixture();
    // 40 MiB of dense packet headers does not cause a full-file read or exhaust
    // the parser budget merely because speculative coalescing used its allowance.
    const count = 5000;
    for (let index = 0; index < count; index++) {
      const start = index * 8192;
      await reader.read(start, start + 12);
      await reader.read(start + 12, start + 20);
    }
    const lengths = read.mock.calls.map((call) => call[1]);
    expect(lengths.some((length) => length === 512 * 1024)).toBe(true);
    expect(lengths.at(-1)).toBe(1024);
    expect(lengths.length).toBeLessThan(count / 2);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  // Explicit local-only benchmark: no SFTP, provider access, sockets or giant allocations.
  // SUBTITLE_READER_BENCHMARK=1 scripts/dev.sh pnpm exec vitest run apps/api/src/viewer-subtitles.test.ts -t benchmark --disableConsoleIntercept
  it.skipIf(process.env.SUBTITLE_READER_BENCHMARK !== '1')(
    'benchmark: reports dense and sparse virtual movie scan costs',
    async () => {
      const rows = [];
      for (const payload of [64, 2048, 8192, 32768, 131072, 262144, 1048576]) {
        const movie = unindexedMovie(payload);
        const began = performance.now();
        const viewer = await createSubtitleViewer(movie.source, {
          signal: new AbortController().signal,
        });
        try {
          const window = await viewer.readWindow('2', 2);
          expect(window.cues.map((cue) => cue.text)).toEqual(['Subtitle after skipped video']);
          expect(movie.transferred()).toBeLessThanOrEqual(32 * 1024 * 1024);
          rows.push({
            packetBytes: payload,
            virtualBytes: movie.source.size,
            reads: movie.reads(),
            transferredBytes: movie.transferred(),
            elapsedMs: Math.round((performance.now() - began) * 100) / 100,
          });
        } finally {
          viewer.close();
        }
      }
      console.table(rows);
    },
  );

  it('cancels an individual request promptly without aborting the shared SFTP handle', async () => {
    const { source, reader, read, request, lifetime } = fixture();
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    read.mockImplementationOnce(() => pending.promise);
    const result = reader.read(0, 12);
    const assertion = expect(result).rejects.toThrow('request cancelled');
    request.abort(new Error('request cancelled'));
    await assertion;
    expect(read.mock.calls[0]?.[2]).toBe(lifetime.signal);
    expect(lifetime.signal.aborted).toBe(false);
    pending.resolve(new Uint8Array(1024));
    const next = new SubtitleMetadataReader(source, new AbortController().signal, lifetime.signal);
    next.resetBudget(1024);
    expect(await next.read(0, 12)).toHaveLength(12);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
