import { ADTS, AudioSampleSink, FLAC, Input, MP3, MP4, OGG, UrlSource, WAVE } from 'mediabunny';
import { waveformEligible, waveformLimits } from './audio-waveform-model.js';
import {
  consumeWaveform,
  StreamingWaveform,
  type WaveformMessage,
  type WaveformRequest,
} from './audio-waveform-stream.js';

// DOM and worker libraries overlap in TypeScript. Describe only this module's worker surface.
const worker = globalThis as unknown as {
  location: Location;
  onmessage: ((event: MessageEvent<WaveformRequest | { type: 'cancel' }>) => void) | null;
  postMessage: (
    message: WaveformMessage | { type: 'cancelled' },
    transfer?: Transferable[],
  ) => void;
};

let started = false;
let cancelled = false;
let activeInput: Input | undefined;
let activeAbort: AbortController | undefined;
worker.onmessage = (event) => {
  if ('type' in event.data && event.data.type === 'cancel') {
    cancelled = true;
    activeAbort?.abort();
    activeInput?.dispose();
    worker.postMessage({ type: 'cancelled' });
    return;
  }
  if (!('url' in event.data)) return;
  if (started || cancelled) return;
  started = true;
  void analyze(event.data).catch(() => {
    if (!cancelled) worker.postMessage({ type: 'error' });
  });
};

async function analyze(request: WaveformRequest) {
  if (!waveformEligible(request.size, request.duration)) throw new Error('Waveform limit');
  const url = new URL(request.url);
  if (
    url.origin !== worker.location.origin ||
    url.username ||
    url.password ||
    !/^\/v1\/servers\/[^/]+\/files\/viewer\/(?:archive\/)?content$/.test(url.pathname)
  ) {
    throw new Error('Invalid viewer source');
  }
  let backgroundError: unknown;
  const cancellation = new AbortController();
  activeAbort = cancellation;
  const input = new Input({
    formats: [WAVE, MP3, OGG, FLAC, MP4, ADTS],
    source: new UrlSource(url, {
      maxCacheSize: 2 * 1024 * 1024,
      parallelism: 1,
      getRetryDelay: () => null,
      requestInit: { credentials: 'same-origin', redirect: 'error' },
      handleUnhandledError: (error) => {
        backgroundError = error;
        cancellation.abort();
        input.dispose();
      },
      fetchFn: async (request, options) => {
        const response = await fetch(request, {
          ...options,
          signal: options?.signal
            ? AbortSignal.any([options.signal, cancellation.signal])
            : cancellation.signal,
        });
        const total = Number(response.headers.get('content-range')?.split('/')[1]);
        const length = Number(response.headers.get('content-length'));
        if (total > waveformLimits.bytes || length > waveformLimits.bytes) {
          await response.body?.cancel();
          throw new Error('Waveform source too large');
        }
        return response;
      },
    }),
  });
  activeInput = input;
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || (await track.getNumberOfChannels()) > 8 || !(await track.canDecode())) {
      throw new Error('Unsupported audio track');
    }
    // Raw ADTS has no declared duration: the media element reports a bitrate
    // estimate. Count encoded frames using the existing bounded source cache.
    const rawAac = (await input.getFormat()) === ADTS;
    const duration = rawAac ? await track.computeDuration() : request.duration;
    await consumeWaveform(
      new AudioSampleSink(track).samples(),
      // Other formats retain the existing native timeline; ADTS uses frame timestamps.
      new StreamingWaveform(duration),
      (message) => {
        if (cancelled) throw new DOMException('Aborted', 'AbortError');
        if (backgroundError) throw backgroundError;
        worker.postMessage(
          { ...message, ...(rawAac ? { duration } : {}) },
          message.type === 'error' ? [] : [message.peaks.buffer],
        );
      },
    );
  } finally {
    cancellation.abort();
    input.dispose();
    activeInput = undefined;
    activeAbort = undefined;
  }
}
