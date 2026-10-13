import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSubtitleSource, subtitleLimits } from './subtitle-source.js';

const url = 'https://panel.example/v1/servers/example/files/viewer/content?path=/movie.mkv';
const text = new TextEncoder();
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));
const raw = (value: number, width = Math.max(1, Math.ceil(Math.log2(value + 1) / 8))) => {
  const result = new Uint8Array(width);
  for (let index = width - 1; index >= 0; index--) {
    result[index] = value % 256;
    value = Math.floor(value / 256);
  }
  return result;
};
const element = (tag: number, ...parts: Uint8Array[]) => {
  const data = concat(...parts);
  const width = Math.max(1, Math.ceil(Math.log2(data.length + 2) / 7));
  const length = raw(data.length, width);
  length[0] = (length[0] ?? 0) | (1 << (8 - width));
  return concat(raw(tag), length, data);
};
const integer = (tag: number, value: number, width?: number) => element(tag, raw(value, width));
const string = (tag: number, value: string) => element(tag, text.encode(value));
const ebml = element(0x1a45dfa3, string(0x4282, 'matroska'));
const track = (extra = new Uint8Array(), codec = 'S_TEXT/UTF8') =>
  element(
    0x1654ae6b,
    element(0xae, integer(0xd7, 3), integer(0x83, 17), string(0x86, codec), extra),
  );
const block = (value: string, duration = 4000, relative = 0, flags = 0) =>
  element(
    0xa0,
    element(
      0xa1,
      new Uint8Array([0x83, (relative >> 8) & 255, relative & 255, flags]),
      text.encode(value),
    ),
    ...(duration ? [integer(0x9b, duration)] : []),
  );
const cluster = (time: number, ...blocks: Uint8Array[]) =>
  element(0x1f43b675, integer(0xe7, time), ...blocks);
const file = (...parts: Uint8Array[]) => concat(ebml, element(0x18538067, ...parts));
function serve(bytes: Uint8Array) {
  vi.stubGlobal('location', new URL('https://panel.example/servers/example/files'));
  const ranges: [number, number][] = [];
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    expect(options.credentials).toBe('same-origin');
    expect(options.redirect).toBe('error');
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(options.headers).get('Range') ?? '');
    if (!range) throw new Error('Missing bounded range');
    const start = Number(range[1]),
      end = Number(range[2]);
    ranges.push([start, end]);
    return new Response(Uint8Array.from(bytes.subarray(start, end + 1)), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, ranges };
}
async function open(bytes: Uint8Array) {
  const mock = serve(bytes);
  const source = await openSubtitleSource(url, bytes.length, new AbortController().signal);
  expect(source).not.toBeNull();
  if (!source) throw new Error('Expected Matroska');
  return { source, ...mock };
}
afterEach(() => vi.unstubAllGlobals());

describe('Motion selective Matroska subtitle source', () => {
  it('reads real authored SRT, ASS, SSA, VTT track metadata and precise timed packets', async () => {
    const path = new URL('../../../../tests/fixtures/motion-subtitles.mkv.base64', import.meta.url);
    const { source, fetch } = await open(Buffer.from(readFileSync(path, 'utf8').trim(), 'base64'));
    expect(source.tracks.map((item) => item.format)).toEqual(['srt', 'ass', 'ssa', 'vtt', null]);
    expect(source.tracks.map((item) => item.supported)).toEqual([true, true, true, true, false]);
    for (const entry of source.tracks.filter((item) => item.supported)) {
      const result = await source.readWindow(entry.id, 0);
      expect(result.cues.map((cue) => [cue.start, cue.end])).toEqual([
        [1, 4],
        [6, 9],
      ]);
      expect(result.cues.every((cue) => cue.text.length > 0)).toBe(true);
      if (entry.format === 'ass' || entry.format === 'ssa') {
        expect(entry.header).toContain('[Script Info]');
        expect(result.cues[0]?.text).toMatch(/^\d+,/);
      }
      if (entry.format === 'vtt') expect(result.cues[0]?.settings).toBe('line:80%');
    }
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
    const future = await source.readWindow(source.tracks[0]?.id ?? '', 120);
    expect(future.cues).toEqual([]);
    expect(future.end).toBe(140);
    source.dispose();
  });
  it('handles unindexed subtitle blocks, signed offsets and an earlier long cue after a seek', async () => {
    const { source } = await open(
      file(
        track(),
        cluster(1000, block('long overlay', 120000, -500)),
        cluster(60000, block('current', 5000)),
        cluster(150000, block('future')),
      ),
    );
    const first = await source.readWindow('3', 62);
    expect(first.cues.map((cue) => [cue.text, cue.start, cue.end])).toEqual([
      ['long overlay', 0.5, 120.5],
      ['current', 60, 65],
    ]);
    const repeated = await source.readWindow('3', 0);
    expect(repeated.cues.map((cue) => cue.text)).toEqual(['long overlay']);
    const before = await source.readWindow('3', 119);
    expect(before.cues.map((cue) => cue.text)).toEqual(['long overlay']);
    source.dispose();
  });
  it('uses the bounded scan for Cues missing relative positions without losing unindexed long cues', async () => {
    const tracks = track();
    const first = cluster(0, block('long', 3605000), block('unindexed overlap', 3605000, 1000));
    const filler = element(
      0x1f43b675,
      integer(0xe7, 10000),
      element(0xa3, new Uint8Array([0x81, 0, 0, 0]), new Uint8Array(2 * 1024 * 1024)),
      block('unindexed cluster', 3601000),
    );
    const last = cluster(3600000, block('far', 10000));
    const makeIndex = (firstPosition: number, lastPosition: number) =>
      element(
        0x1c53bb6b,
        ...[
          [0, 3605000, firstPosition],
          [3600000, 10000, lastPosition],
        ].map(([time = 0, duration = 0, position = 0]) =>
          element(
            0xbb,
            integer(0xb3, time, 4),
            element(0xb7, integer(0xf7, 3), integer(0xf1, position, 4), integer(0xb2, duration, 4)),
          ),
        ),
      );
    const sampleIndex = makeIndex(0, 0);
    const firstPosition = tracks.length + sampleIndex.length;
    const bytes = file(
      tracks,
      makeIndex(firstPosition, firstPosition + first.length + filler.length),
      first,
      filler,
      last,
    );
    const { source, ranges } = await open(bytes);
    const result = await source.readWindow('3', 3601);
    expect(result.cues.map((cue) => cue.text)).toEqual([
      'long',
      'unindexed overlap',
      'unindexed cluster',
      'far',
    ]);
    expect(ranges.reduce((total, [start, end]) => total + end - start + 1, 0)).toBeLessThan(
      256 * 1024,
    );
    expect(ranges.some(([start, end]) => start < 1024 * 1024 && end >= 1024 * 1024)).toBe(false);
    source.dispose();
  });
  it('reads startup and a far seek in an indexed 2GiB movie using less than 256KiB of Range data', async () => {
    const header = (tag: number, length: number) =>
      concat(raw(tag), new Uint8Array([1]), raw(length, 7));
    const tracks = track();
    const bodySize = 2 ** 31;
    const farPosition = bodySize - 65536;
    const startTime = integer(0xe7, 0),
      farTime = integer(0xe7, 3600000);
    // Typical small encoded A/V packets, not one enormous packet the fallback could
    // skip cheaply. Only selected prefix regions are materialized by this fixture.
    const av = element(0xa3, new Uint8Array([0x81, 0, 0, 0]), new Uint8Array(32760));
    const makeIndex = (firstPosition: number) =>
      element(
        0x1c53bb6b,
        ...[
          [0, 3605000, firstPosition, startTime.length + av.length],
          [3600000, 10000, farPosition, farTime.length + av.length],
        ].map(([time = 0, duration = 0, position = 0, relative = 0]) =>
          element(
            0xbb,
            integer(0xb3, time, 4),
            element(
              0xb7,
              integer(0xf7, 3),
              integer(0xf1, position, 8),
              integer(0xf0, relative, 4),
              integer(0xb2, duration, 4),
            ),
          ),
        ),
      );
    const firstPosition = tracks.length + makeIndex(0).length;
    const segment = header(0x18538067, bodySize);
    const base = ebml.length + segment.length;
    const firstPrefix = concat(
      header(0x1f43b675, farPosition - firstPosition - 12),
      startTime,
      av,
      block('Long indexed overlay', 3605000),
    );
    const farPrefix = concat(
      header(0x1f43b675, bodySize - farPosition - 12),
      farTime,
      av,
      block('One hour later', 10000),
    );
    const fragments: [number, Uint8Array][] = [
      [0, concat(ebml, segment, tracks, makeIndex(firstPosition))],
      [base + firstPosition, firstPrefix],
      [base + farPosition, farPrefix],
    ];
    const size = base + bodySize;
    vi.stubGlobal('location', new URL('https://panel.example'));
    let received = 0;
    const requests: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(options.headers).get('Range') ?? '');
        if (!match) throw new Error('Expected bounded Range');
        const start = Number(match[1]),
          end = Number(match[2]);
        requests.push(start);
        const data = new Uint8Array(end - start + 1);
        // Any accidental linear scan encounters repeated small video blocks, then
        // the normal byte/time bounds, instead of a shortcut through a giant Void.
        const repeatStart = base + firstPosition + firstPrefix.length;
        for (let offset = Math.max(start, repeatStart); offset <= end; offset++)
          data[offset - start] = av[(offset - repeatStart) % av.length] ?? 0;
        for (const [offset, bytes] of fragments) {
          const left = Math.max(offset, start),
            right = Math.min(offset + bytes.length, end + 1);
          if (left < right) data.set(bytes.subarray(left - offset, right - offset), left - start);
        }
        received += data.length;
        return new Response(data, {
          status: 206,
          headers: { 'content-range': `bytes ${start}-${end}/${size}` },
        });
      }),
    );
    const source = await openSubtitleSource(url, size, new AbortController().signal);
    if (!source) throw new Error('Expected indexed Matroska');
    expect((await source.readWindow('3', 0)).cues.map((cue) => cue.text)).toEqual([
      'Long indexed overlay',
    ]);
    expect(
      (await source.readWindow('3', 3601)).cues.map((cue) => [cue.text, cue.start, cue.end]),
    ).toEqual([
      ['Long indexed overlay', 0, 3605],
      ['One hour later', 3600, 3610],
    ]);
    expect(received).toBeLessThan(256 * 1024);
    expect(requests.every((start) => start < 65536 || start >= base + farPosition - 65536)).toBe(
      true,
    );
    source.dispose();
  });
  it('does not invent duration and rejects unsupported subtitle lacing', async () => {
    const missing = await open(file(track(), cluster(0, block('missing duration', 0))));
    await expect(missing.source.readWindow('3', 0)).rejects.toThrow('duration unavailable');
    missing.source.dispose();
    const laced = await open(file(track(), cluster(0, block('laced', 1000, 0, 2))));
    await expect(laced.source.readWindow('3', 0)).rejects.toThrow('Laced');
    laced.source.dispose();
    const defaultDuration = await open(
      file(
        track(integer(0x23e383, 2000000000)),
        cluster(0, element(0xa3, new Uint8Array([0x83, 0, 0, 0]), text.encode('default duration'))),
      ),
    );
    expect((await defaultDuration.source.readWindow('3', 0)).cues[0]?.end).toBe(2);
    defaultDuration.source.dispose();
  });
  it('marks bitmap, compressed and nonunit timestamp-scale tracks unavailable', async () => {
    const bitmap = await open(
      file(track(element(0x63a2, new Uint8Array([255])), 'S_HDMV/PGS'), cluster(0)),
    );
    expect(bitmap.source.tracks[0]?.supported).toBe(false);
    await expect(bitmap.source.readWindow('3', 0)).rejects.toThrow('Unsupported');
    bitmap.source.dispose();
    const compressed = await open(file(track(element(0x6d80)), cluster(0)));
    expect(compressed.source.tracks[0]?.supported).toBe(false);
    compressed.source.dispose();
    const scaled = await open(
      file(track(element(0x23314f, new Uint8Array([0x40, 0, 0, 0]))), cluster(0)),
    );
    expect(scaled.source.tracks[0]?.supported).toBe(false);
    scaled.source.dispose();
  });
  it('extracts only bounded font attachments lazily and never follows embedded paths', async () => {
    const font = concat(new Uint8Array([0, 1, 0, 0]), new Uint8Array(16));
    const attached = (name: string, data: Uint8Array) =>
      element(0x61a7, string(0x466e, name), element(0x465c, data));
    const { source } = await open(
      file(
        track(undefined, 'S_TEXT/ASS'),
        element(
          0x1941a469,
          attached('Typeface.ttf', font),
          attached('../../bad.ttf', font),
          attached('not-a-font.ttf', new Uint8Array(20)),
          attached('cover.html', text.encode('<script>bad()</script>')),
        ),
        cluster(0),
      ),
    );
    expect((await source.fonts()).map((item) => item.name)).toEqual(['Typeface.ttf']);
    expect(await source.fonts()).toBe(await source.fonts());
    source.dispose();
  });
  it('cancels a superseded window without poisoning later windows, and disposal forbids reads', async () => {
    const { source, fetch } = await open(file(track(), cluster(0, block('visible'))));
    const cancel = new AbortController();
    cancel.abort();
    await expect(source.readWindow('3', 0, cancel.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect((await source.readWindow('3', 0)).cues).toHaveLength(1);
    const count = fetch.mock.calls.length;
    source.dispose();
    await expect(source.readWindow('3', 0)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch.mock.calls.length).toBe(count);
  });
  it('aborts the actual in-flight Range fetch and immediately permits a new window', async () => {
    const bytes = file(
      track(),
      cluster(
        0,
        element(0xa3, new Uint8Array([0x81, 0, 0, 0]), new Uint8Array(128 * 1024)),
        block('after video'),
      ),
    );
    const { source, fetch: original } = await open(bytes);
    let started: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, options: RequestInit) => {
        if (new Headers(options.headers).get('Range') === 'bytes=0-65535')
          return original(input, options);
        fetchSignal = options.signal ?? undefined;
        started();
        return new Promise<Response>((_resolve, reject) => {
          fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), { once: true });
        });
      }),
    );
    const cancel = new AbortController();
    const window = source.readWindow('3', 0, cancel.signal);
    const result = expect(window).rejects.toMatchObject({ name: 'AbortError' });
    await waiting;
    cancel.abort();
    await result;
    expect(fetchSignal?.aborted).toBe(true);
    vi.stubGlobal('fetch', original);
    expect((await source.readWindow('3', 0)).cues[0]?.text).toBe('after video');
    source.dispose();
  });
  it('refuses external URLs, malformed element lengths, oversized cues and full-file responses', async () => {
    const bytes = file(track(), cluster(0, block('x')));
    serve(bytes);
    await expect(
      openSubtitleSource('https://evil.example/video', bytes.length, new AbortController().signal),
    ).rejects.toThrow('Invalid subtitle source');
    const broken = concat(
      ebml,
      raw(0x18538067),
      new Uint8Array([0x01, 255, 255, 255, 255, 255, 255, 254]),
    );
    serve(broken);
    await expect(
      openSubtitleSource(url, broken.length, new AbortController().signal),
    ).rejects.toThrow();
    const oversized = await open(
      file(track(), cluster(0, block('x'.repeat(subtitleLimits.textBytes + 1)))),
    );
    await expect(oversized.source.readWindow('3', 0)).rejects.toThrow('Oversized subtitle cue');
    oversized.source.dispose();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes)),
    );
    await expect(
      openSubtitleSource(url, bytes.length, new AbortController().signal),
    ).rejects.toThrow('range unavailable');
  });
  it('returns null for MP4 rather than claiming embedded subtitle support', async () => {
    const bytes = concat(raw(24, 4), text.encode('ftypisom'), new Uint8Array(12));
    const { fetch } = serve(bytes);
    expect(await openSubtitleSource(url, bytes.length, new AbortController().signal)).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
