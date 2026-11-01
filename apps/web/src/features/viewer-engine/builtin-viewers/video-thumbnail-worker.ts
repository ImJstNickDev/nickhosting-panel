import {
  CanvasSink,
  EncodedPacketSink,
  Input,
  MATROSKA,
  MP4,
  QTFF,
  UrlSource,
  WEBM,
} from 'mediabunny';
import {
  ThumbnailReadBudget,
  type ThumbnailReply,
  type ThumbnailRequest,
  thumbnailLimits,
} from './video-thumbnail-model.js';

const worker = globalThis as unknown as {
  location: Location;
  onmessage: ((event: MessageEvent<ThumbnailRequest | { type: 'cancel' }>) => void) | null;
  postMessage: (message: ThumbnailReply) => void;
};
let cancelled = false;
let busy = false;
let activeInput: Input | undefined;
let abort: AbortController | undefined;
let sinks: Promise<{ packets: EncodedPacketSink; canvases: CanvasSink }> | undefined;
let canvas: OffscreenCanvas | undefined;
const readBudget = new ThumbnailReadBudget();

function release() {
  abort?.abort();
  activeInput?.dispose();
  activeInput = undefined;
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
  canvas = undefined;
}

function fail() {
  if (!cancelled) worker.postMessage({ type: 'error' });
  cancelled = true;
  release();
}

worker.onmessage = (event) => {
  if (event.data.type === 'cancel') {
    cancelled = true;
    release();
    worker.postMessage({ type: 'cancelled' });
    return;
  }
  if (busy || cancelled) return;
  busy = true;
  readBudget.reset();
  // Unindexed files and pathological metadata may otherwise scan indefinitely.
  const timeout = setTimeout(fail, thumbnailLimits.requestMs);
  void thumbnail(event.data)
    .catch(fail)
    .finally(() => {
      clearTimeout(timeout);
      busy = false;
    });
};

async function initialize(request: ThumbnailRequest) {
  const url = new URL(request.url);
  if (
    url.origin !== worker.location.origin ||
    url.username ||
    url.password ||
    !/^\/v1\/servers\/[^/]+\/files\/viewer\/(?:archive\/)?content$/.test(url.pathname) ||
    !Number.isSafeInteger(request.size) ||
    request.size <= 0
  )
    throw new Error('Invalid viewer source');
  const cancellation = new AbortController();
  abort = cancellation;
  const input = new Input({
    // File containers supporting indexed seeking; byte/time budgets bound missing indexes.
    // Never resolve playlists or external media providers.
    formats: [MP4, QTFF, WEBM, MATROSKA],
    source: new UrlSource(url, {
      maxCacheSize: 2 * 1024 * 1024,
      parallelism: 1,
      getRetryDelay: () => null,
      requestInit: { credentials: 'same-origin', redirect: 'error' },
      handleUnhandledError: fail,
      fetchFn: async (source, options) => {
        const response = await fetch(source, {
          ...options,
          signal: options?.signal
            ? AbortSignal.any([options.signal, cancellation.signal])
            : cancellation.signal,
        });
        // Refuse a sequential full-download fallback or a changed file. Playback remains native.
        const total = Number(response.headers.get('content-range')?.split('/')[1]);
        if (response.status !== 206 || total !== request.size || !response.body) {
          await response.body?.cancel();
          throw new Error('Video range unavailable');
        }
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              readBudget.consume(chunk.byteLength);
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, { status: response.status, headers: response.headers });
      },
    }),
  });
  activeInput = input;
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) throw new Error('Unsupported video track');
  // CanvasSink closes each decoded VideoSample after drawing. No bitmaps are retained.
  return {
    packets: new EncodedPacketSink(track),
    canvases: new CanvasSink(track, { width: 160, height: 90, fit: 'contain', poolSize: 1 }),
  };
}

async function thumbnail(request: ThumbnailRequest) {
  if (!Number.isFinite(request.bucket) || request.bucket < 0) throw new Error('Invalid time');
  sinks ??= initialize(request);
  const { packets, canvases } = await sinks;
  if (cancelled) return;
  const packet = await packets.getKeyPacket(request.bucket, { metadataOnly: true });
  if (cancelled) return;
  if (!packet) {
    worker.postMessage({ type: 'empty', bucket: request.bucket });
    return;
  }
  if (request.cachedKeys.includes(packet.timestamp)) {
    worker.postMessage({
      type: 'thumbnail',
      bucket: request.bucket,
      key: packet.timestamp,
      time: packet.timestamp,
    });
    return;
  }
  // Decode at the preceding keyframe, not through the entire GOP to the pointer's exact time.
  const frame = await canvases.getCanvas(packet.timestamp);
  if (cancelled) {
    if (frame) {
      frame.canvas.width = 0;
      frame.canvas.height = 0;
    }
    return;
  }
  if (!frame) {
    worker.postMessage({ type: 'empty', bucket: request.bucket });
    return;
  }
  canvas = frame.canvas as OffscreenCanvas;
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
  if (!cancelled)
    worker.postMessage({
      type: 'thumbnail',
      bucket: request.bucket,
      key: packet.timestamp,
      time: frame.timestamp,
      blob,
    });
}
