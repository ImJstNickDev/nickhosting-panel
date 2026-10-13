import { describe, expect, it, vi } from 'vitest';
import type { ViewerReadSource } from './viewer-cache.js';
import { createSubtitleViewer, SubtitleMetadataReader } from './viewer-subtitles.js';

/** Sparse original Matroska fixture: 1 GiB of skipped video, not allocated in RAM. */
function unindexedMovie() {
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
  const payload = 1024 * 1024;
  const block = Buffer.concat([header(0xa3, payload + 4), Buffer.from([0x81, 0, 0, 0])]);
  const cluster = header(
    0x1f43b675,
    timestamp.length + 1000 * (block.length + payload) + cue.length,
  );
  const segment = header(
    0x18538067,
    tracks.length +
      cluster.length +
      timestamp.length +
      1000 * (block.length + payload) +
      cue.length,
  );
  const spans: { start: number; bytes: Buffer }[] = [];
  let size = 0;
  const add = (bytes: Buffer) => {
    spans.push({ start: size, bytes });
    size += bytes.length;
  };
  add(Buffer.concat([metadata, segment, tracks, cluster, timestamp]));
  for (let index = 0; index < 1000; index++) {
    add(block);
    size += payload;
  }
  add(cue);
  let transferred = 0;
  const source: ViewerReadSource = {
    size,
    mtimeMs: 1,
    async read(start, length) {
      transferred += length;
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
  return { source, transferred: () => transferred };
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
      expect(movie.transferred()).toBeLessThan(1100 * 1024);
      const bytes = movie.transferred();
      expect(await viewer.readWindow('2', 3)).toBe(window);
      expect(movie.transferred()).toBe(bytes);
    } finally {
      viewer.close();
    }
  });
  it('reads small headers across large skipped media payloads without fetching those payloads', async () => {
    const { reader, read } = fixture();
    for (let index = 0; index < 1000; index++) {
      const start = index * 2 * 1024 * 1024;
      expect(await reader.read(start, start + 12)).toHaveLength(12);
      expect(await reader.read(start + 12, start + 20)).toHaveLength(8);
    }
    expect(read).toHaveBeenCalledTimes(1000);
    expect(read.mock.calls.reduce((sum, call) => sum + call[1], 0)).toBe(1024 * 1000);
    expect(read.mock.calls.every((call) => call[1] === 1024)).toBe(true);
  });

  it('limits the byte cache to 2 MiB and charges the budget only for actual SFTP reads', async () => {
    const { reader, read } = fixture();
    for (let index = 0; index < 2049; index++) await reader.read(index * 2048, index * 2048 + 12);
    reader.resetBudget(0);
    await reader.read(2048 * 2048, 2048 * 2048 + 12);
    expect(read).toHaveBeenCalledTimes(2049);
    await expect(reader.read(0, 12)).rejects.toThrow('viewer_subtitles_unavailable');
    expect(read).toHaveBeenCalledTimes(2049);
    reader.resetBudget(1024);
    await reader.read(0, 12);
    expect(read).toHaveBeenCalledTimes(2050);
  });

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
