import {
  CustomSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  StreamTarget,
  WEBM,
} from 'mediabunny';
import type {
  MotionTimingValues,
  MotionTrace,
} from '../../../../../../packages/core/src/motion-timing.js';

export const videoSourceLimits = {
  blockBytes: 64 * 1024,
  playbackBlockBytes: 512 * 1024,
  cacheBytes: 2 * 1024 * 1024,
  discoveryBytes: 8 * 1024 * 1024,
  windowBytes: 32 * 1024 * 1024,
  packetBytes: 8 * 1024 * 1024,
  aheadSeconds: 12,
  retainedBytes: 128 * 1024 * 1024,
  maxFragmentSeconds: 30,
  operationMs: 15000,
} as const;

export type VideoAudioTrack = {
  id: string;
  name: string | null;
  language: string;
  codec: string | null;
  supported: boolean;
};
export type PlaybackSnapshot = {
  time: number;
  playing: boolean;
  rate: number;
  volume: number;
  muted: boolean;
};
export const capturePlayback = (media: HTMLVideoElement): PlaybackSnapshot => ({
  time: Number.isFinite(media.currentTime) ? media.currentTime : 0,
  playing: !media.paused && !media.ended,
  rate: media.playbackRate,
  volume: media.volume,
  muted: media.muted,
});
export function bufferedContains(ranges: TimeRanges, time: number, margin = 0) {
  for (let index = 0; index < ranges.length; index++)
    if (time >= ranges.start(index) - margin && time <= ranges.end(index) + margin) return true;
  return false;
}
function bufferedEnd(ranges: TimeRanges, time: number) {
  for (let index = 0; index < ranges.length; index++)
    if (time >= ranges.start(index) - 0.1 && time <= ranges.end(index) + 0.1)
      return ranges.end(index);
  return time;
}
export function mediaSourceConstructor(): typeof MediaSource | undefined {
  const managed = (globalThis as unknown as { ManagedMediaSource?: typeof MediaSource })
    .ManagedMediaSource;
  return typeof MediaSource !== 'undefined' ? MediaSource : managed;
}
const abortError = () => new DOMException('Video source cancelled', 'AbortError');

/** One bounded block cache plus Mediabunny's separately bounded metadata cache. */
export class VideoRangeReader {
  private cache = new Map<string, Uint8Array<ArrayBuffer>>();
  private cachedBytes = 0;
  private pending = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  private queue: Promise<unknown> = Promise.resolve();
  private blockBytes: number = videoSourceLimits.blockBytes;
  streaming() {
    this.blockBytes = videoSourceLimits.playbackBlockBytes;
  }
  private remaining: number = videoSourceLimits.discoveryBytes;
  constructor(
    readonly url: string,
    readonly size: number,
    readonly signal: AbortSignal,
    private readonly trace?: MotionTrace,
  ) {}
  resetBudget(bytes: number) {
    this.remaining = bytes;
  }
  clear() {
    this.cache.clear();
    this.cachedBytes = 0;
    this.pending.clear();
  }
  private async block(start: number): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted();
    const end = Math.min(this.size, start + this.blockBytes);
    const key = `${start}:${end}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const queued = this.trace?.span('video.range_queue');
    const request = this.queue
      .catch(() => {})
      .then(async () => {
        queued?.({ outcome: this.signal.aborted ? 'cancelled' : 'succeeded' });
        this.signal.throwIfAborted();
        this.remaining -= end - start;
        if (this.remaining < 0) throw new Error('Video read budget exceeded');
        const finish = this.trace?.span('video.range');
        let headersReady = this.trace?.span('video.range_headers');
        const values: MotionTimingValues | undefined = this.trace ? {} : undefined;
        try {
          const response = await fetch(this.url, {
            headers: { Range: `bytes=${start}-${end - 1}` },
            credentials: 'same-origin',
            redirect: 'error',
            signal: AbortSignal.any([
              this.signal,
              AbortSignal.timeout(videoSourceLimits.operationMs),
            ]),
          });
          headersReady?.({ outcome: 'succeeded', status: response.status });
          headersReady = undefined;
          if (values) {
            values.status = response.status;
            const requestId = response.headers.get('x-request-id');
            if (
              requestId &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
            )
              values.requestId = requestId;
            const timing = response.headers
              .get('server-timing')
              ?.match(/(?:^|,)\s*nh-motion;dur=([\d.]+)/);
            if (timing && Number.isFinite(Number(timing[1]))) values.serverMs = Number(timing[1]);
          }
          if (
            response.status !== 206 ||
            response.headers.get('content-range') !== `bytes ${start}-${end - 1}/${this.size}`
          ) {
            await response.body?.cancel();
            throw new Error('Video range unavailable or file changed');
          }
          // Do not trust a provider to honor its advertised Content-Range length.
          if (!response.body) throw new Error('Missing video body');
          const bytes = new Uint8Array(end - start);
          const reader = response.body.getReader();
          let offset = 0;
          try {
            while (true) {
              this.signal.throwIfAborted();
              const next = await reader.read();
              if (next.done) break;
              if (offset + next.value.byteLength > bytes.length)
                throw new Error('Excess video range bytes');
              bytes.set(next.value, offset);
              offset += next.value.byteLength;
            }
            if (offset !== bytes.length) throw new Error('Incomplete video range');
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          this.signal.throwIfAborted();
          this.cache.set(key, bytes);
          this.cachedBytes += bytes.byteLength;
          while (this.cachedBytes > videoSourceLimits.cacheBytes) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cachedBytes -= this.cache.get(oldest)?.byteLength ?? 0;
            this.cache.delete(oldest);
          }
          finish?.({ ...values, bytes: bytes.length, outcome: 'succeeded' });
          return bytes;
        } catch (error) {
          headersReady?.({ outcome: this.signal.aborted ? 'cancelled' : 'failed' });
          finish?.({
            ...values,
            outcome:
              this.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
                ? 'cancelled'
                : 'failed',
          });
          throw error;
        }
      });
    this.queue = request;
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      this.pending.delete(key);
    }
  }
  async read(start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end > this.size ||
      end <= start ||
      end - start > videoSourceLimits.packetBytes
    )
      throw new Error('Oversized video read');
    const result = new Uint8Array(end - start);
    let position = start;
    while (position < end) {
      const blockStart = Math.floor(position / this.blockBytes) * this.blockBytes;
      const block = await this.block(blockStart);
      const count = Math.min(end - position, block.length - (position - blockStart));
      result.set(
        block.subarray(position - blockStart, position - blockStart + count),
        position - start,
      );
      position += count;
    }
    return result;
  }
}
export function openVideoInput(
  url: string,
  size: number,
  signal: AbortSignal,
  trace?: MotionTrace,
) {
  const parsed = new URL(url, location.href);
  if (
    parsed.origin !== location.origin ||
    parsed.username ||
    parsed.password ||
    !/^\/v1\/servers\/[^/]+\/files\/viewer\/(?:archive\/)?content$/.test(parsed.pathname) ||
    !Number.isSafeInteger(size) ||
    size <= 0
  )
    throw new Error('Invalid video source');
  const reader = new VideoRangeReader(parsed.href, size, signal, trace);
  const input = new Input({
    formats: [MP4, QTFF, WEBM, MATROSKA],
    source: new CustomSource({
      getSize: () => size,
      read: (start, end) => reader.read(start, end),
      maxCacheSize: videoSourceLimits.cacheBytes,
      prefetchProfile: 'none',
      dispose: () => reader.clear(),
      handleUnhandledError: () => {},
    }),
  });
  return { input, reader };
}
export async function inspectVideo(input: Input) {
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getAudioTracks();
  const primary = await input.getPrimaryAudioTrack();
  const videoCodec = await video?.getCodecParameterString();
  const factory = mediaSourceConstructor();
  const allowed = new Mp4OutputFormat().getSupportedCodecs();
  const tracks = await Promise.all(
    audio.map(async (track): Promise<VideoAudioTrack> => {
      const codec = await track.getCodec();
      const parameter = codec ? await track.getCodecParameterString() : null;
      const mime =
        videoCodec && parameter ? `video/mp4; codecs="${videoCodec},${parameter}"` : null;
      return {
        id: String(track.id),
        name: await track.getName(),
        language: await track.getLanguageCode(),
        codec: codec ?? String((await track.getInternalCodecId()) ?? 'unknown'),
        supported: Boolean(
          factory && mime && codec && allowed.includes(codec) && factory.isTypeSupported(mime),
        ),
      };
    }),
  );
  return { tracks, primaryId: primary ? String(primary.id) : null, video };
}

/** MSE writes are serialized and every pending append/removal is abortable. */
export function updateSourceBuffer(
  buffer: SourceBuffer,
  signal: AbortSignal,
  update: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => failed(), videoSourceLimits.operationMs);
    const cleanup = () => {
      clearTimeout(timer);
      buffer.removeEventListener('updateend', done);
      buffer.removeEventListener('error', failed);
      buffer.removeEventListener('abort', aborted);
      signal.removeEventListener('abort', aborted);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error('Video buffer failed'));
    };
    const aborted = () => {
      cleanup();
      reject(abortError());
    };
    buffer.addEventListener('updateend', done);
    buffer.addEventListener('error', failed);
    buffer.addEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    try {
      update();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
function waitFor(target: EventTarget, event: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(event, done);
      signal.removeEventListener('abort', cancel);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const cancel = () => {
      cleanup();
      reject(abortError());
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    target.addEventListener(event, done, { once: true });
    signal.addEventListener('abort', cancel, { once: true });
  });
}
function pausePump(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, 200);
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Conservative encoded-byte accounting: partially removed fragments keep their full charge.
 * Records contain no media bytes. Coalescing bounds metadata without undercounting retained data.
 */
export class VideoBufferBudget {
  private fragments: { start: number; end: number; bytes: number; group: number }[] = [];
  get bytes() {
    return this.fragments.reduce((total, fragment) => total + fragment.bytes, 0);
  }
  add(start: number, end: number, bytes: number, group = 0) {
    const last = this.fragments.at(-1);
    if (last && last.start === start && last.end === end && last.group === group)
      last.bytes += bytes;
    else this.fragments.push({ start, end, bytes, group });
    if (this.fragments.length > 4096) {
      const first = this.fragments.shift();
      const next = this.fragments[0];
      if (first && next) {
        next.start = Math.min(first.start, next.start);
        next.end = Math.max(first.end, next.end);
        next.bytes += first.bytes;
      }
    }
  }
  reconcile(ranges: TimeRanges, pendingGroup?: number) {
    this.fragments = this.fragments.filter((part) => {
      if (part.group === pendingGroup) return true;
      for (let index = 0; index < ranges.length; index++)
        if (part.start <= ranges.end(index) && part.end >= ranges.start(index)) return true;
      return false;
    });
  }
}
/** Choose the distant side of a buffered range, protecting the current second on either side. */
export function videoBufferEviction(ranges: TimeRanges, time: number): [number, number] | null {
  let selected: [number, number] | null = null;
  let distance = -1;
  for (let index = 0; index < ranges.length; index++) {
    const start = ranges.start(index),
      end = ranges.end(index);
    for (const [left, right] of [
      [start, Math.min(end, time - 1)],
      [Math.max(start, time + 1), end],
    ]) {
      if (left === undefined || right === undefined || right - left < 0.05) continue;
      const candidate = Math.max(Math.abs(time - left), Math.abs(time - right));
      if (candidate > distance) {
        selected = [left, right];
        distance = candidate;
      }
    }
  }
  return selected;
}

type VideoSessionContext = {
  input: Input;
  reader: VideoRangeReader;
  video: NonNullable<Awaited<ReturnType<Input['getPrimaryVideoTrack']>>>;
  audio: Awaited<ReturnType<Input['getAudioTracks']>>[number];
  source: MediaSource;
  buffer: SourceBuffer;
  duration: number;
};

export class VideoMseSession {
  readonly cancellation = new AbortController();
  ready = false;
  private input?: Input;
  private objectUrl?: string;
  private context?: VideoSessionContext;
  private pump?: AbortController;
  private pumpTask: Promise<void> = Promise.resolve();
  private budget = new VideoBufferBudget();
  private fragmentGroup = 0;
  private pumpTarget = 0;
  private refillAfterLocalSeek = false;
  private startupFinish?: ReturnType<MotionTrace['span']>;
  private startupDeadline = 0;
  private mutations: Promise<void> = Promise.resolve();
  private mutate(buffer: SourceBuffer, signal: AbortSignal, update: () => void) {
    const next = this.mutations
      .catch(() => {})
      .then(() => updateSourceBuffer(buffer, signal, update));
    this.mutations = next;
    return next;
  }
  constructor(
    private options: {
      media: HTMLVideoElement;
      url: string;
      size: number;
      trackId: string;
      snapshot: PlaybackSnapshot;
      trace?: MotionTrace;
      onReady: () => void;
      onError: () => void;
    },
  ) {}
  dispose() {
    this.cancellation.abort();
    this.pump?.abort();
    this.input?.dispose();
    this.input = undefined;
    this.context = undefined;
    this.startupFinish?.({ outcome: 'cancelled' });
    this.startupFinish = undefined;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }
  /** Preserve Input, bounded Range cache, SourceBuffer and blob URL across same-track seeks. */
  seek(time: number, refill = false) {
    const context = this.context;
    if (!context || this.cancellation.signal.aborted) return;
    if (!refill && this.ready && bufferedContains(context.buffer.buffered, time, 0.05)) {
      this.refillAfterLocalSeek = Math.abs(time - this.pumpTarget) > 0.5;
      return;
    }
    this.refillAfterLocalSeek = false;
    this.pumpTarget = time;
    this.pump?.abort();
    const pump = new AbortController();
    this.pump = pump;
    // Old demux work and its writes settle before a new muxer can touch the same input/parser.
    this.pumpTask = this.pumpTask
      .catch(() => {})
      .then(async () => {
        if (pump.signal.aborted || this.cancellation.signal.aborted) return;
        await this.run(context, time, pump);
      });
  }
  async start() {
    const { media, url, size, trackId, trace } = this.options;
    this.startupFinish = trace?.span('mse.start');
    this.startupDeadline = performance.now() + videoSourceLimits.operationMs;
    let phase = trace?.span('mse.metadata');
    const signal = this.cancellation.signal;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.cancellation.abort();
    }, videoSourceLimits.operationMs);
    try {
      const { input, reader } = openVideoInput(trace?.url(url, 'mse') ?? url, size, signal, trace);
      this.input = input;
      const video = await input.getPrimaryVideoTrack();
      const audio = (await input.getAudioTracks()).find((track) => String(track.id) === trackId);
      if (!video || !audio) throw new Error('Missing video or audio track');
      const duration = await input.getDurationFromMetadata([video, audio]);
      const videoConfig = await video.getDecoderConfig();
      const audioConfig = await audio.getDecoderConfig();
      const factory = mediaSourceConstructor();
      if (!duration || !Number.isFinite(duration) || !factory || !videoConfig || !audioConfig)
        throw new Error('Unsupported video configuration');
      const mime = `video/mp4; codecs="${videoConfig.codec},${audioConfig.codec}"`;
      if (!factory.isTypeSupported(mime)) throw new Error('Unsupported video codecs');
      phase?.({ outcome: 'succeeded' });
      phase = undefined;
      signal.throwIfAborted();
      const source = new factory();
      phase = trace?.span('mse.source_open');
      const opened = waitFor(source, 'sourceopen', signal);
      this.objectUrl = URL.createObjectURL(source);
      if (typeof MediaSource === 'undefined' || factory !== MediaSource)
        media.disableRemotePlayback = true;
      const settings = capturePlayback(media);
      media.src = this.objectUrl;
      media.load();
      media.volume = settings.volume;
      media.muted = settings.muted;
      media.playbackRate = settings.rate;
      await opened;
      phase?.({ outcome: 'succeeded' });
      phase = undefined;
      signal.throwIfAborted();
      const buffer = source.addSourceBuffer(mime);
      source.duration = duration;
      reader.streaming();
      this.context = { input, reader, video, audio, source, buffer, duration };
      this.seek(this.options.snapshot.time);
    } catch {
      const outcome = signal.aborted && !timedOut ? 'cancelled' : 'failed';
      phase?.({ outcome });
      this.startupFinish?.({ outcome });
      this.startupFinish = undefined;
      if (!signal.aborted || timedOut) this.options.onError();
      this.dispose();
    } finally {
      clearTimeout(timer);
    }
  }
  private async evict(
    context: VideoSessionContext,
    signal: AbortSignal,
    time: number,
    pendingGroup: number,
  ) {
    const range = videoBufferEviction(context.buffer.buffered, time);
    if (!range) return false;
    await this.mutate(context.buffer, signal, () => context.buffer.remove(...range));
    // Floating-point/sample boundaries must not turn partial removal into a full budget refund.
    this.budget.reconcile(context.buffer.buffered, pendingGroup);
    return true;
  }
  private async run(context: VideoSessionContext, requested: number, pump: AbortController) {
    const { media, trace, snapshot } = this.options;
    const { reader, video, audio, source, buffer, duration } = context;
    const signal = AbortSignal.any([pump.signal, this.cancellation.signal]);
    let finish = this.ready ? trace?.span('mse.refill') : this.startupFinish;
    this.startupFinish = undefined;
    let phase = trace?.span('mse.first_packets');
    let output: Output | undefined;
    let primed = false;
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        pump.abort();
      },
      this.ready
        ? videoSourceLimits.operationMs
        : Math.max(0, this.startupDeadline - performance.now()),
    );
    try {
      await this.mutations.catch(() => {});
      signal.throwIfAborted();
      // appendBuffer reopens an ended MediaSource. abort() then resets only the partial parser,
      // preserving coded frames from previous compatible initialization segments.
      if (source.readyState === 'ended')
        await this.mutate(buffer, signal, () => buffer.appendBuffer(new Uint8Array()));
      if (buffer.updating) {
        const reset = waitFor(buffer, 'updateend', signal);
        buffer.abort();
        await reset;
      } else buffer.abort();
      reader.resetBudget(videoSourceLimits.windowBytes);
      const videoSink = new EncodedPacketSink(video),
        audioSink = new EncodedPacketSink(audio);
      const target = Math.max(0, Math.min(duration - 0.001, requested));
      let nextVideo =
        (await videoSink.getKeyPacket(target, { verifyKeyPackets: true })) ??
        (await videoSink.getFirstKeyPacket({ verifyKeyPackets: true }));
      if (!nextVideo || target - nextVideo.timestamp > videoSourceLimits.maxFragmentSeconds)
        throw new Error('Video keyframe too distant');
      let nextAudio =
        (await audioSink.getPacket(Math.max(0, nextVideo.timestamp))) ??
        (await audioSink.getFirstPacket());
      if (!nextAudio) throw new Error('Empty audio track');
      const videoConfig = await video.getDecoderConfig(),
        audioConfig = await audio.getDecoderConfig();
      const videoCodec = await video.getCodec(),
        audioCodec = await audio.getCodec();
      if (!videoConfig || !audioConfig || !videoCodec || !audioCodec)
        throw new Error('Missing codecs');
      phase?.({ outcome: 'succeeded' });
      phase = trace?.span('mse.first_buffer');
      let lastWritten = 0,
        unflushedBytes = 0;
      let fragmentStart = Math.min(nextVideo.timestamp, nextAudio.timestamp);
      let fragmentTimestamp = fragmentStart;
      let submittedEnd = fragmentStart;
      let fragmentGroup = ++this.fragmentGroup;
      output = new Output({
        format: new Mp4OutputFormat({
          fastStart: 'fragmented',
          minimumFragmentDuration: 1,
          onMoof: (_data, _position, timestamp) => {
            fragmentTimestamp = timestamp;
            fragmentGroup = ++this.fragmentGroup;
          },
        }),
        target: new StreamTarget(
          new WritableStream({
            write: async ({ data, position }) => {
              signal.throwIfAborted();
              if (position !== lastWritten || data.length > videoSourceLimits.windowBytes)
                throw new Error('Invalid video fragment');
              // Browsers can evict coded frames independently. Reconcile completed fragments,
              // retaining the current fragment charge until its parser input has fully arrived.
              while (true) {
                this.budget.reconcile(buffer.buffered, fragmentGroup);
                if (this.budget.bytes + data.length <= videoSourceLimits.retainedBytes) break;
                if (!(await this.evict(context, signal, media.currentTime, fragmentGroup)))
                  await pausePump(signal);
              }
              while (true) {
                try {
                  await this.mutate(buffer, signal, () => buffer.appendBuffer(data));
                  break;
                } catch (error) {
                  if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError')
                    throw error;
                  if (!(await this.evict(context, signal, media.currentTime, fragmentGroup)))
                    await pausePump(signal);
                }
              }
              this.budget.add(
                Math.max(0, fragmentTimestamp),
                Math.max(fragmentTimestamp, submittedEnd),
                data.length,
                fragmentGroup,
              );
              lastWritten += data.length;
              unflushedBytes = 0;
              reader.resetBudget(videoSourceLimits.windowBytes);
            },
          }),
        ),
      });
      const videoSource = new EncodedVideoPacketSource(videoCodec),
        audioSource = new EncodedAudioPacketSource(audioCodec);
      output.addVideoTrack(videoSource, {
        decoderConfig: videoConfig,
        transformationMatrix: await video.getTransformationMatrix(),
      });
      output.addAudioTrack(audioSource, { decoderConfig: audioConfig });
      await output.start();
      let finished = false;
      while (!signal.aborted) {
        const position = primed ? media.currentTime : target;
        const end = bufferedEnd(buffer.buffered, position);
        const firstCommon = buffer.buffered.length ? buffer.buffered.start(0) : Infinity;
        const initialGap = target === 0 && firstCommon > 0 && firstCommon < 1;
        if (!primed && (bufferedContains(buffer.buffered, target, 0.05) || initialGap)) {
          primed = true;
          phase?.({ outcome: 'succeeded' });
          phase = undefined;
          finish?.({ outcome: 'succeeded', mediaSeconds: target });
          finish = undefined;
          clearTimeout(timer);
          if (!this.ready) {
            media.currentTime = initialGap ? firstCommon : target;
            this.ready = true;
            this.options.onReady();
            if (snapshot.playing) await media.play();
          }
        }
        // A local seek may enter another retained island. Refill its approaching gap
        // from the new position instead of demuxing the intervening media again.
        if (
          primed &&
          end < duration - 0.1 &&
          end < position + videoSourceLimits.aheadSeconds &&
          this.refillAfterLocalSeek
        ) {
          this.seek(position, true);
          return;
        }
        if (primed && (finished || end >= position + videoSourceLimits.aheadSeconds)) {
          await pausePump(signal);
          continue;
        }
        if (finished) throw new Error('No common audio/video range at requested time');
        if (!nextVideo && !nextAudio) {
          await output.finalize();
          signal.throwIfAborted();
          if (source.readyState === 'open') source.endOfStream();
          finished = true;
          continue;
        }
        const useVideo = nextVideo && (!nextAudio || nextVideo.timestamp <= nextAudio.timestamp);
        const packet = useVideo ? nextVideo : nextAudio;
        if (!packet) throw new Error('Missing packet');
        unflushedBytes += packet.data.byteLength;
        submittedEnd = Math.max(submittedEnd, packet.timestamp + packet.duration);
        if (
          unflushedBytes > videoSourceLimits.windowBytes ||
          packet.data.byteLength > videoSourceLimits.packetBytes ||
          packet.timestamp - fragmentStart > videoSourceLimits.maxFragmentSeconds
        )
          throw new Error('Video fragment exceeds streaming limits');
        const before = lastWritten;
        if (useVideo) {
          await videoSource.add(packet);
          signal.throwIfAborted();
          nextVideo = await videoSink.getNextPacket(packet);
          if (!nextVideo) videoSource.close();
        } else {
          await audioSource.add(packet);
          signal.throwIfAborted();
          nextAudio = await audioSink.getNextPacket(packet);
          if (!nextAudio) audioSource.close();
        }
        if (lastWritten > before) fragmentStart = packet.timestamp;
      }
    } catch {
      const outcome = signal.aborted && !timedOut ? 'cancelled' : 'failed';
      phase?.({ outcome });
      phase = undefined;
      finish?.({ outcome });
      finish = undefined;
      if (
        (!signal.aborted || timedOut) &&
        this.pump === pump &&
        !this.cancellation.signal.aborted
      ) {
        this.options.onError();
        this.dispose();
      }
    } finally {
      phase?.({ outcome: 'cancelled' });
      finish?.({ outcome: 'cancelled' });
      clearTimeout(timer);
      if (output) await output.cancel().catch(() => {});
    }
  }
}
