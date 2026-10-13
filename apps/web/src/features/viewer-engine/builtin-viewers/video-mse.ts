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
  behindSeconds: 8,
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
  private cache = new Map<number, Uint8Array<ArrayBuffer>>();
  private pending = new Map<number, Promise<Uint8Array<ArrayBuffer>>>();
  private queue: Promise<unknown> = Promise.resolve();
  private blockBytes: number = videoSourceLimits.blockBytes;
  streaming() {
    this.cache.clear();
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
    this.pending.clear();
  }
  private async block(start: number): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted();
    const cached = this.cache.get(start);
    if (cached) {
      this.cache.delete(start);
      this.cache.set(start, cached);
      return cached;
    }
    const pending = this.pending.get(start);
    if (pending) return pending;
    const queued = this.trace?.span('video.range_queue');
    const request = this.queue
      .catch(() => {})
      .then(async () => {
        queued?.({ outcome: this.signal.aborted ? 'cancelled' : 'succeeded' });
        this.signal.throwIfAborted();
        const end = Math.min(this.size, start + this.blockBytes);
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
          this.cache.set(start, bytes);
          while (this.cache.size * this.blockBytes > videoSourceLimits.cacheBytes) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
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
    this.pending.set(start, request);
    try {
      return await request;
    } finally {
      this.pending.delete(start);
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

export class VideoMseSession {
  readonly cancellation = new AbortController();
  ready = false;
  private input?: Input;
  private output?: Output;
  private objectUrl?: string;
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
    this.input?.dispose();
    this.input = undefined;
    if (this.output) void this.output.cancel().catch(() => {});
    this.output = undefined;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }
  async start() {
    const { media, url, size, trackId, snapshot, trace } = this.options;
    let finish = trace?.span('mse.start');
    let phase = trace?.span('mse.metadata');
    const signal = this.cancellation.signal;
    let startupTimedOut = false;
    const startupTimer = setTimeout(() => {
      startupTimedOut = true;
      this.cancellation.abort();
    }, videoSourceLimits.operationMs);
    try {
      const { input, reader } = openVideoInput(trace?.url(url, 'mse') ?? url, size, signal, trace);
      this.input = input;
      const video = await input.getPrimaryVideoTrack();
      const audio = (await input.getAudioTracks()).find((track) => String(track.id) === trackId);
      if (!video || !audio) throw new Error('Missing video or audio track');
      const duration = await input.getDurationFromMetadata([video, audio]);
      if (!duration || !Number.isFinite(duration)) throw new Error('Missing indexed duration');
      const videoConfig = await video.getDecoderConfig();
      const audioConfig = await audio.getDecoderConfig();
      const videoCodec = await video.getCodec(),
        audioCodec = await audio.getCodec();
      const factory = mediaSourceConstructor();
      if (!factory || !videoConfig || !audioConfig || !videoCodec || !audioCodec)
        throw new Error('Unsupported video configuration');
      const mime = `video/mp4; codecs="${videoConfig.codec},${audioConfig.codec}"`;
      if (!factory.isTypeSupported(mime)) throw new Error('Unsupported video codecs');
      phase?.({ outcome: 'succeeded' });
      phase = trace?.span('mse.first_packets');
      reader.resetBudget(videoSourceLimits.windowBytes);
      reader.streaming();
      const videoSink = new EncodedPacketSink(video),
        audioSink = new EncodedPacketSink(audio);
      const target = Math.max(0, Math.min(duration - 0.001, snapshot.time));
      let nextVideo =
        (await videoSink.getKeyPacket(target, { verifyKeyPackets: true })) ??
        (await videoSink.getFirstKeyPacket({ verifyKeyPackets: true }));
      if (!nextVideo || target - nextVideo.timestamp > videoSourceLimits.maxFragmentSeconds)
        throw new Error('Video keyframe too distant');
      let nextAudio =
        (await audioSink.getPacket(Math.max(0, nextVideo.timestamp))) ??
        (await audioSink.getFirstPacket());
      if (!nextAudio) throw new Error('Empty audio track');
      phase?.({ outcome: 'succeeded' });
      phase = trace?.span('mse.source_open');
      signal.throwIfAborted();
      const source = new factory();
      const opened = waitFor(source, 'sourceopen', signal);
      this.objectUrl = URL.createObjectURL(source);
      // ManagedMediaSource on Safari requires inline playback and no remote playback.
      if (typeof MediaSource === 'undefined' || factory !== MediaSource)
        media.disableRemotePlayback = true;
      const currentOptions = capturePlayback(media);
      media.src = this.objectUrl;
      media.load();
      media.volume = currentOptions.volume;
      media.muted = currentOptions.muted;
      media.playbackRate = currentOptions.rate;
      await opened;
      phase?.({ outcome: 'succeeded' });
      phase = trace?.span('mse.first_buffer');
      signal.throwIfAborted();
      const buffer = source.addSourceBuffer(mime);
      source.duration = duration;
      let lastWritten = 0;
      let unflushedBytes = 0;
      let fragmentStart = Math.min(nextVideo.timestamp, nextAudio.timestamp);
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
        target: new StreamTarget(
          new WritableStream({
            write: async ({ data, position }) => {
              signal.throwIfAborted();
              if (position !== lastWritten || data.length > videoSourceLimits.windowBytes)
                throw new Error('Invalid video fragment');
              while (true) {
                try {
                  await this.mutate(buffer, signal, () => buffer.appendBuffer(data));
                  break;
                } catch (error) {
                  if (
                    !(error instanceof DOMException) ||
                    error.name !== 'QuotaExceededError' ||
                    !this.ready
                  )
                    throw error;
                  // Backpressure while paused; play/seek/close can release this bounded pending fragment.
                  const before = media.currentTime - 1;
                  if (before > 0 && buffer.buffered.length && buffer.buffered.start(0) < before)
                    await this.mutate(buffer, signal, () => buffer.remove(0, before));
                  await pausePump(signal);
                }
              }
              lastWritten += data.length;
              unflushedBytes = 0;
              reader.resetBudget(videoSourceLimits.windowBytes);
            },
          }),
        ),
      });
      this.output = output;
      const videoSource = new EncodedVideoPacketSource(videoCodec);
      const audioSource = new EncodedAudioPacketSource(audioCodec);
      output.addVideoTrack(videoSource, {
        decoderConfig: videoConfig,
        transformationMatrix: await video.getTransformationMatrix(),
      });
      output.addAudioTrack(audioSource, { decoderConfig: audioConfig });
      await output.start();
      let finished = false;
      while (!signal.aborted) {
        const position = this.ready ? media.currentTime : target;
        const end = bufferedEnd(buffer.buffered, position);
        const firstCommon = buffer.buffered.length ? buffer.buffered.start(0) : Infinity;
        const initialGap = target === 0 && firstCommon > 0 && firstCommon < 1;
        if (!this.ready && (bufferedContains(buffer.buffered, target, 0.05) || initialGap)) {
          media.currentTime = initialGap ? firstCommon : target;
          this.ready = true;
          phase?.({ outcome: 'succeeded' });
          phase = undefined;
          finish?.({ outcome: 'succeeded', mediaSeconds: media.currentTime });
          finish = undefined;
          clearTimeout(startupTimer);
          this.options.onReady();
          if (snapshot.playing) await media.play();
        }
        if (this.ready && !finished && end >= position + videoSourceLimits.aheadSeconds) {
          await this.trim(buffer, signal, position);
          await pausePump(signal);
          reader.resetBudget(videoSourceLimits.windowBytes);
          continue;
        }
        if (finished) {
          if (!this.ready) throw new Error('No common audio/video range at requested time');
          await this.trim(buffer, signal, position);
          await pausePump(signal);
          continue;
        }
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
        if (
          unflushedBytes > videoSourceLimits.windowBytes ||
          packet.data.byteLength > videoSourceLimits.packetBytes ||
          packet.timestamp - fragmentStart > videoSourceLimits.maxFragmentSeconds
        )
          throw new Error('Video fragment exceeds streaming limits');
        const before = lastWritten;
        if (useVideo) {
          await videoSource.add(packet);
          nextVideo = await videoSink.getNextPacket(packet);
          if (!nextVideo) videoSource.close();
        } else {
          await audioSource.add(packet);
          nextAudio = await audioSink.getNextPacket(packet);
          if (!nextAudio) audioSource.close();
        }
        if (lastWritten > before) fragmentStart = packet.timestamp;
        await this.trim(buffer, signal, position);
      }
    } catch {
      const outcome = signal.aborted && !startupTimedOut ? 'cancelled' : 'failed';
      phase?.({ outcome });
      phase = undefined;
      if (!this.ready) finish?.({ outcome });
      finish = undefined;
      if (!signal.aborted || startupTimedOut) this.options.onError();
    } finally {
      if (!this.ready) {
        phase?.({ outcome: 'cancelled' });
        finish?.({ outcome: 'cancelled' });
      }
      clearTimeout(startupTimer);
      this.dispose();
    }
  }
  private async trim(buffer: SourceBuffer, signal: AbortSignal, time: number) {
    const before = time - videoSourceLimits.behindSeconds;
    if (before > 0 && buffer.buffered.length && buffer.buffered.start(0) < before - 1)
      await this.mutate(buffer, signal, () => buffer.remove(0, before));
  }
}
