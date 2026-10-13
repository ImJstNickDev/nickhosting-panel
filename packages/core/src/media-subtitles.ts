/** Deliberately a subtitle reader, not a second audio/video demuxer.
 * Matroska mappings: https://www.matroska.org/technical/subtitles.html
 * EBML and index layout: https://www.matroska.org/technical/elements.html
 */
export type SubtitleTrack = {
  id: string;
  name: string | null;
  language: string;
  format: 'srt' | 'ass' | 'ssa' | 'vtt' | null;
  codec: string;
  supported: boolean;
  default: boolean;
  forced: boolean;
  header: string;
};
export type SubtitleCue = {
  id: string;
  start: number;
  end: number;
  /** ASS/SSA retains Matroska's ReadOrder,Layer,Style,Name,MarginL,R,V,Effect,Text. */
  text: string;
  /** Matroska WebVTT BlockAdditional's first line; never interpreted as HTML/CSS. */
  settings?: string;
};
export type SubtitleWindow = { start: number; end: number; cues: SubtitleCue[] };
export type SubtitleFont = { name: string; data: Uint8Array<ArrayBuffer> };
export type SubtitleSource = {
  tracks: SubtitleTrack[];
  readWindow(trackId: string, time: number, signal?: AbortSignal): Promise<SubtitleWindow>;
  fonts(signal?: AbortSignal): Promise<SubtitleFont[]>;
  dispose(): void;
};
export const subtitleLimits = {
  operationBytes: 8 * 1024 * 1024,
  metadataBytes: 4 * 1024 * 1024,
  textBytes: 256 * 1024,
  fontBytes: 4 * 1024 * 1024,
  fontsBytes: 8 * 1024 * 1024,
  fontCount: 16,
  trackCount: 64,
  indexEntries: 100000,
  clusterCount: 20000,
  windowCues: 4000,
  windowSeconds: 20,
  operationMs: 15000,
} as const;

const id = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  info: 0x1549a966,
  tracks: 0x1654ae6b,
  cues: 0x1c53bb6b,
  cluster: 0x1f43b675,
  attachments: 0x1941a469,
} as const;
type Element = { id: number; start: number; data: number; end: number; unknown: boolean };
type Track = SubtitleTrack & { number: number; duration?: number; delay: number };
type IndexEntry = {
  track: number;
  time: number;
  duration?: number;
  position: number;
  relative?: number;
};
type Block = { element: Element; time: number; duration?: number; settings?: string };
const decode = new TextDecoder('utf-8', { fatal: true });
const invalid = () => new Error('Invalid or unsupported Matroska subtitle structure');
function integer(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 8) throw invalid();
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  if (!Number.isSafeInteger(value)) throw invalid();
  return value;
}
function vint(bytes: Uint8Array, offset: number, identifier = false) {
  const first = bytes[offset];
  if (!first) throw invalid();
  let width = 1;
  while (width <= 8 && !(first & (1 << (8 - width)))) width++;
  if ((identifier && width > 4) || width > 8 || offset + width > bytes.length) throw invalid();
  let value = identifier ? first : first & ((1 << (8 - width)) - 1);
  let unknown = !identifier && value === (1 << (8 - width)) - 1;
  for (let at = 1; at < width; at++) {
    const byte = bytes[offset + at] ?? 0;
    value = value * 256 + byte;
    unknown &&= byte === 255;
  }
  if (!unknown && !Number.isSafeInteger(value)) throw invalid();
  return { value, width, unknown };
}

export interface SubtitleByteReader {
  read(start: number, endExclusive: number): Promise<Uint8Array<ArrayBuffer>>;
  resetBudget(bytes: number): void;
  clear(): void;
}

export class MatroskaSubtitles implements SubtitleSource {
  tracks: Track[] = [];
  private reader: SubtitleByteReader;
  private controller = new AbortController();
  private readerCancel = new AbortController();
  private signal: AbortSignal;
  private currentSignal?: AbortSignal;
  private deadline = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private segment!: Element;
  private scale = 0.001;
  private locations = new Map<number, Element>();
  private index: IndexEntry[] = [];
  private clusterPositions: number[] = [];
  private pastClusters = new Map<string, { next: number; time: number; maxEnd: number }>();
  private scanPosition = 0;
  private scannedEnd = false;
  private cachedWindow: { track: string; window: SubtitleWindow } | null = null;
  private fontCache: SubtitleFont[] | null = null;

  constructor(
    readonly size: number,
    readonly makeReader: (signal: AbortSignal) => SubtitleByteReader,
    signal: AbortSignal,
  ) {
    if (!Number.isSafeInteger(size) || size < 12) throw new Error('Invalid subtitle source');
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.reader = this.createReader();
  }
  private createReader() {
    return this.makeReader(AbortSignal.any([this.signal, this.readerCancel.signal]));
  }
  dispose() {
    this.controller.abort();
    this.reader.clear();
    this.cachedWindow = null;
    this.fontCache = null;
    this.index = [];
    this.clusterPositions = [];
    this.pastClusters.clear();
  }
  private check() {
    this.signal.throwIfAborted();
    this.currentSignal?.throwIfAborted();
    if (performance.now() > this.deadline) throw new Error('Subtitle scan time limit exceeded');
  }
  private run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.queue
      .catch(() => {})
      .then(async () => {
        this.currentSignal = signal;
        this.deadline = performance.now() + subtitleLimits.operationMs;
        this.reader.resetBudget(subtitleLimits.operationBytes);
        this.check();
        const cancelled = () => this.readerCancel.abort(signal?.reason);
        signal?.addEventListener('abort', cancelled, { once: true });
        const timeout = setTimeout(
          () => this.readerCancel.abort(new Error('Subtitle scan time limit exceeded')),
          subtitleLimits.operationMs,
        );
        try {
          return await operation();
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', cancelled);
          this.currentSignal = undefined;
          if (this.readerCancel.signal.aborted) {
            this.reader.clear();
            this.readerCancel = new AbortController();
            this.reader = this.createReader();
          }
        }
      });
    this.queue = result;
    return result;
  }
  private async bytes(start: number, end: number) {
    this.check();
    const result = await this.reader.read(start, end);
    this.check();
    return result;
  }
  private async element(start: number, limit: number): Promise<Element> {
    if (start < 0 || start >= limit || limit > this.size) throw invalid();
    const prefix = await this.bytes(start, Math.min(start + 12, limit));
    const tag = vint(prefix, 0, true);
    const length = vint(prefix, tag.width);
    const data = start + tag.width + length.width;
    const end = length.unknown ? limit : data + length.value;
    if (!Number.isSafeInteger(end) || end > limit || end < data) throw invalid();
    if (length.unknown && tag.value !== id.segment && tag.value !== id.cluster) throw invalid();
    return { id: tag.value, start, data, end, unknown: length.unknown };
  }
  private async children(element: Element, maximum = 100000) {
    const result: Element[] = [];
    for (let at = element.data; at < element.end; ) {
      if (result.length >= maximum) throw new Error('Subtitle element limit exceeded');
      const child = await this.element(at, element.end);
      result.push(child);
      at = child.end;
    }
    return result;
  }
  private async text(element: Element, maximum: number = subtitleLimits.textBytes) {
    if (element.end - element.data > maximum) throw new Error('Oversized subtitle text');
    return element.data === element.end
      ? ''
      : decode.decode(await this.bytes(element.data, element.end));
  }
  private async number(element: Element) {
    if (element.end - element.data > 8) throw invalid();
    return integer(await this.bytes(element.data, element.end));
  }
  private async locate(position: number, expected: number) {
    const element = await this.element(position, this.segment.end);
    if (element.id !== expected || element.unknown) throw invalid();
    this.locations.set(expected, element);
    return element;
  }
  async open() {
    return this.run(async () => {
      if (integer(await this.bytes(0, 4)) !== id.ebml) return false;
      const ebml = await this.element(0, this.size);
      if (ebml.id !== id.ebml) return false;
      const docType = (await this.children(ebml, 64)).find((entry) => entry.id === 0x4282);
      if (!docType || !['matroska', 'webm'].includes(await this.text(docType, 32))) return false;
      let at = ebml.end;
      while (at < this.size) {
        const element = await this.element(at, this.size);
        if (element.id === id.segment) {
          this.segment = element;
          break;
        }
        at = element.end;
      }
      if (!this.segment) throw invalid();
      const heads: Element[] = [];
      for (at = this.segment.data; at < this.segment.end; ) {
        const element = await this.element(at, this.segment.end);
        if (element.id === id.cluster) {
          this.scanPosition = at;
          break;
        }
        this.locations.set(element.id, element);
        if (element.id === id.seekHead) heads.push(element);
        at = element.end;
      }
      if (!this.scanPosition) this.scannedEnd = true;
      const visited = new Set<number>();
      for (let headIndex = 0; headIndex < heads.length; headIndex++) {
        const head = heads[headIndex];
        if (!head || visited.has(head.start)) continue;
        if (visited.size >= 16) throw new Error('Subtitle seek-head limit exceeded');
        visited.add(head.start);
        for (const seek of await this.children(head, 128)) {
          if (seek.id !== 0x4dbb) continue;
          const fields = await this.children(seek, 16);
          const seekId = fields.find((field) => field.id === 0x53ab);
          const seekPosition = fields.find((field) => field.id === 0x53ac);
          if (!seekId || !seekPosition) throw invalid();
          const target = await this.number(seekId);
          if (
            ![id.seekHead, id.info, id.tracks, id.cues, id.attachments].includes(
              target as typeof id.info,
            )
          )
            continue;
          const found = await this.locate(
            this.segment.data + (await this.number(seekPosition)),
            target,
          );
          if (target === id.seekHead) heads.push(found);
        }
      }
      const info = this.locations.get(id.info);
      if (info) {
        const scale = (await this.children(info, 128)).find((field) => field.id === 0x2ad7b1);
        if (scale) this.scale = (await this.number(scale)) / 1e9;
        if (!Number.isFinite(this.scale) || this.scale <= 0 || this.scale > 1) throw invalid();
      }
      const tracks = this.locations.get(id.tracks);
      if (tracks) await this.readTracks(tracks);
      const cues = this.locations.get(id.cues);
      if (cues && this.tracks.some((track) => track.supported)) await this.readIndex(cues);
      return true;
    });
  }
  private async readTracks(element: Element) {
    if (element.end - element.data > subtitleLimits.metadataBytes) throw invalid();
    const numbers = new Set<number>();
    for (const entry of await this.children(element, subtitleLimits.trackCount)) {
      if (entry.id !== 0xae) continue;
      const fields = await this.children(entry, 128);
      const field = (tag: number) => fields.find((value) => value.id === tag);
      const numeric = async (tag: number, fallback = 0) =>
        field(tag) ? this.number(field(tag) as Element) : fallback;
      const string = async (tag: number, fallback = '') =>
        field(tag) ? this.text(field(tag) as Element) : fallback;
      if ((await numeric(0x83)) !== 17) continue;
      const number = await numeric(0xd7);
      if (!number || numbers.has(number)) throw invalid();
      numbers.add(number);
      const codec = await string(0x86);
      const format =
        (
          {
            'S_TEXT/UTF8': 'srt',
            'S_TEXT/ASS': 'ass',
            'S_TEXT/SSA': 'ssa',
            'S_TEXT/WEBVTT': 'vtt',
          } as const
        )[codec as 'S_TEXT/UTF8'] ?? null;
      const scale = field(0x23314f);
      let normalScale = true;
      if (scale) {
        const value = await this.bytes(scale.data, scale.end);
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        normalScale =
          value.length === 4
            ? view.getFloat32(0) === 1
            : value.length === 8 && view.getFloat64(0) === 1;
      }
      const duration = await numeric(0x23e383);
      const supported = Boolean(
        format && normalScale && !field(0x6d80) && (await numeric(0xb9, 1)),
      );
      this.tracks.push({
        id: String(number),
        number,
        codec,
        format,
        supported,
        name: (await string(0x536e)) || null,
        language: (await string(0x22b59d)) || (await string(0x22b59c, 'eng')),
        default: Boolean(await numeric(0x88, 1)),
        forced: Boolean(await numeric(0x55aa)),
        header: supported ? await string(0x63a2) : '',
        duration: duration ? duration / 1e9 : undefined,
        delay: (await numeric(0x56aa)) / 1e9,
      });
    }
  }
  private async readIndex(element: Element) {
    if (element.end - element.data > subtitleLimits.metadataBytes)
      throw new Error('Oversized subtitle index');
    for (const point of await this.children(element, subtitleLimits.indexEntries)) {
      if (point.id !== 0xbb) continue;
      const fields = await this.children(point, 128);
      const timestamp = fields.find((field) => field.id === 0xb3);
      if (!timestamp) throw invalid();
      const time = (await this.number(timestamp)) * this.scale;
      for (const field of fields) {
        if (field.id !== 0xb7) continue;
        const parts = await this.children(field, 32);
        const numeric = async (tag: number) => {
          const part = parts.find((item) => item.id === tag);
          return part ? this.number(part) : undefined;
        };
        const track = await numeric(0xf7),
          offset = await numeric(0xf1);
        if (!track || offset === undefined) throw invalid();
        if (!this.tracks.some((item) => item.number === track && item.supported)) continue;
        if (await numeric(0xea)) throw new Error('Changing subtitle codec state is unsupported');
        if (this.index.length >= subtitleLimits.indexEntries)
          throw new Error('Subtitle index limit exceeded');
        const duration = await numeric(0xb2);
        this.index.push({
          track,
          time,
          position: this.segment.data + offset,
          relative: await numeric(0xf0),
          duration: duration === undefined ? undefined : duration * this.scale,
        });
      }
    }
    this.index.sort((a, b) => a.time - b.time || a.position - b.position);
  }
  private async cluster(position: number) {
    const cluster = await this.element(position, this.segment.end);
    if (cluster.id !== id.cluster) throw invalid();
    let time: number | undefined;
    for (let at = cluster.data; at < cluster.end; ) {
      const element = await this.element(at, cluster.end);
      if (element.id === 0xe7) {
        time = (await this.number(element)) * this.scale;
        break;
      }
      if (element.id === 0xa3 || element.id === 0xa0) throw invalid();
      at = element.end;
    }
    if (time === undefined) throw invalid();
    return { cluster, time };
  }
  private async block(element: Element, time: number, track: Track): Promise<Block | null> {
    if (element.id === 0xa3) return { element, time };
    if (element.id !== 0xa0) return null;
    const fields = await this.children(element, 64);
    const block = fields.find((field) => field.id === 0xa1);
    if (!block) throw invalid();
    const prefix = await this.bytes(block.data, Math.min(block.end, block.data + 8));
    if (vint(prefix, 0).value !== track.number) return null;
    if (fields.some((field) => field.id === 0xa4))
      throw new Error('Changing subtitle codec state is unsupported');
    const duration = fields.find((field) => field.id === 0x9b);
    let settings: string | undefined;
    const additions = fields.find((field) => field.id === 0x75a1);
    if (additions)
      for (const more of await this.children(additions, 16)) {
        if (more.id !== 0xa6) continue;
        const parts = await this.children(more, 8);
        const addId = parts.find((field) => field.id === 0xee);
        const data = parts.find((field) => field.id === 0xa5);
        if (data && (!addId || (await this.number(addId)) === 1))
          settings = (await this.text(data)).split('\n', 1)[0];
      }
    return {
      element: block,
      time,
      settings,
      duration: duration ? (await this.number(duration)) * this.scale : undefined,
    };
  }
  private async cue(
    block: Block,
    track: Track,
    start: number,
    end: number,
    summary: { maxEnd: number },
  ): Promise<SubtitleCue | null> {
    const { element } = block;
    const head = await this.bytes(element.data, Math.min(element.end, element.data + 11));
    const number = vint(head, 0);
    if (number.value !== track.number) return null;
    if (head.length < number.width + 3) throw invalid();
    const offset = new DataView(head.buffer, head.byteOffset + number.width, 2).getInt16(0);
    if ((head[number.width + 2] ?? 0) & 0x06) throw new Error('Laced subtitles are unsupported');
    const begin = block.time + offset * this.scale - track.delay;
    const duration = block.duration ?? track.duration;
    if (duration === undefined || duration <= 0) throw new Error('Subtitle duration unavailable');
    const finish = begin + duration;
    summary.maxEnd = Math.max(summary.maxEnd, finish);
    if (finish <= start || begin >= end) return null;
    const payload = element.data + number.width + 3;
    if (element.end - payload > subtitleLimits.textBytes) throw new Error('Oversized subtitle cue');
    const text =
      payload === element.end ? '' : decode.decode(await this.bytes(payload, element.end));
    return {
      id: String(element.start),
      start: Math.max(0, begin),
      end: finish,
      text,
      settings: block.settings,
    };
  }
  private async clusterCues(position: number, track: Track, start: number, end: number) {
    const key = `${track.id}:${position}`;
    const old = this.pastClusters.get(key);
    if (old && old.maxEnd <= start) return { cues: [], ...old };
    const { cluster, time } = await this.cluster(position);
    const result: SubtitleCue[] = [];
    const summary = { maxEnd: Number.NEGATIVE_INFINITY };
    let at = cluster.data;
    if (at < cluster.data || at >= cluster.end) throw invalid();
    for (let count = 0; at < cluster.end; count++) {
      if (count >= 100000) throw new Error('Subtitle cluster element limit exceeded');
      const element = await this.element(at, cluster.end);
      // Unknown-sized clusters end at the next segment-level element.
      if (cluster.unknown && Object.values(id).includes(element.id as typeof id.info)) {
        cluster.end = at;
        break;
      }
      const block = await this.block(element, time, track);
      if (block) {
        const cue = await this.cue(block, track, start, end, summary);
        if (cue) result.push(cue);
        if (result.length > subtitleLimits.windowCues)
          throw new Error('Subtitle cue limit exceeded');
      }
      at = element.end;
    }
    this.pastClusters.set(key, { next: cluster.end, time, maxEnd: summary.maxEnd });
    if (this.pastClusters.size > subtitleLimits.clusterCount) {
      const oldest = this.pastClusters.keys().next().value;
      if (oldest !== undefined) this.pastClusters.delete(oldest);
    }
    return { cues: result, next: cluster.end, time };
  }
  hasUsableIndex(trackId: string) {
    const track = this.tracks.find((item) => item.id === trackId);
    const index = this.index.filter((entry) => entry.track === track?.number);
    return (
      index.length > 0 &&
      index.every(
        (entry) =>
          entry.duration !== undefined && entry.duration > 0 && entry.relative !== undefined,
      )
    );
  }
  readWindow(trackId: string, time: number, signal?: AbortSignal) {
    return this.run(async () => {
      const track = this.tracks.find((item) => item.id === trackId);
      if (!track?.supported || !Number.isFinite(time) || time < 0)
        throw new Error('Unsupported subtitle selection');
      const previous = this.cachedWindow;
      if (
        previous?.track === trackId &&
        time >= previous.window.start &&
        time < previous.window.end - 3
      )
        return previous.window;
      const start = Math.max(0, time - 2),
        end = time + subtitleLimits.windowSeconds;
      const cues = new Map<string, SubtitleCue>();
      const append = (entries: SubtitleCue[]) => {
        for (const cue of entries) cues.set(cue.id, cue);
        if (cues.size > subtitleLimits.windowCues) throw new Error('Subtitle cue limit exceeded');
      };
      const index = this.index.filter((entry) => entry.track === track.number);
      if (this.hasUsableIndex(trackId)) {
        // Matroska recommends every subtitle frame be indexed with duration; ordinary
        // FFmpeg/mkvmerge files follow this. Trust that index instead of downloading
        // A/V bytes to verify it. Well-formed-but-incomplete subtitle indexes are not
        // supported by this fast path; missing fields use the bounded scan below.
        // https://www.matroska.org/technical/cues.html
        for (const entry of index) {
          if (entry.time - track.delay >= end) break;
          if (entry.time + (entry.duration ?? 0) - track.delay <= start) continue;
          const { cluster, time: clusterTime } = await this.cluster(entry.position);
          const element = await this.element(cluster.data + (entry.relative ?? 0), cluster.end);
          const packet = await this.block(element, clusterTime, track);
          if (!packet) throw invalid();
          const cue = await this.cue(packet, track, start, end, {
            maxEnd: Number.NEGATIVE_INFINITY,
          });
          if (
            !cue ||
            Math.abs(cue.start - Math.max(0, entry.time - track.delay)) > 0.001 ||
            Math.abs(cue.end - (entry.time + (entry.duration ?? 0) - track.delay)) > 0.001
          )
            throw new Error('Subtitle index does not match packet timing');
          append([cue]);
        }
      } else {
        // An absent/incomplete index needs earlier metadata too: this preserves long
        // overlapping cues without guessing a lookback. A/V payload lengths are skipped.
        // Cached past-cluster durations avoid repeating reads as playback advances.
        // A large unindexed movie can hit this bounded fallback's explicit scan limit.
        for (let positionIndex = 0; ; positionIndex++) {
          let position = this.clusterPositions[positionIndex];
          while (position === undefined && !this.scannedEnd) {
            const element = await this.element(this.scanPosition, this.segment.end);
            if (element.id === id.cluster) {
              position = element.start;
              if (this.clusterPositions.length >= subtitleLimits.clusterCount)
                throw new Error('Subtitle cluster limit exceeded');
              this.clusterPositions.push(position);
              break;
            }
            this.scanPosition = element.end;
            if (element.end === this.segment.end) this.scannedEnd = true;
          }
          if (position === undefined) break;
          const result = await this.clusterCues(position, track, start, end);
          append(result.cues);
          if (position === this.scanPosition) {
            this.scanPosition = result.next;
            if (result.next === this.segment.end) this.scannedEnd = true;
          }
          // Signed Block timestamps may precede the Cluster timestamp by 32768 ticks.
          if (result.time - 32768 * this.scale - track.delay >= end) break;
        }
      }

      const window = {
        start,
        end,
        cues: [...cues.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)),
      };
      this.cachedWindow = { track: trackId, window };
      return window;
    }, signal);
  }
  fonts(signal?: AbortSignal) {
    return this.run(async () => {
      if (this.fontCache) return this.fontCache;
      const attachments = this.locations.get(id.attachments);
      const fonts: SubtitleFont[] = [];
      let total = 0;
      if (attachments)
        for (const file of await this.children(attachments, 128)) {
          if (file.id !== 0x61a7) continue;
          const fields = await this.children(file, 32);
          const filename = fields.find((field) => field.id === 0x466e);
          const data = fields.find((field) => field.id === 0x465c);
          if (!filename || !data) continue;
          const name = await this.text(filename, 512);
          // No filesystem writes, external URLs, HTML attachments or document fonts.
          if (
            !/^[^/\\]+\.(?:ttf|otf|woff2?)$/i.test(name) ||
            [...name].some((character) => character.charCodeAt(0) < 32)
          )
            continue;
          const length = data.end - data.data;
          if (
            length < 12 ||
            length > subtitleLimits.fontBytes ||
            fonts.length >= subtitleLimits.fontCount ||
            total + length > subtitleLimits.fontsBytes
          )
            throw new Error('Subtitle font limit exceeded');
          const bytes = await this.bytes(data.data, data.end);
          const magic = integer(bytes.subarray(0, 4));
          if (![0x00010000, 0x4f54544f, 0x774f4646, 0x774f4632, 0x74727565].includes(magic))
            continue;
          fonts.push({ name, data: bytes });
          total += length;
        }
      this.fontCache = fonts;
      return fonts;
    }, signal);
  }
}
