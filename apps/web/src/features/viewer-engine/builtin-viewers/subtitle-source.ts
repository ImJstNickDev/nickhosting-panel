import {
  MatroskaSubtitles,
  type SubtitleSource,
  type SubtitleWindow,
  subtitleLimits,
} from '../../../../../../packages/core/src/media-subtitles.js';
import { VideoRangeReader } from './video-mse.js';

export {
  type SubtitleCue,
  type SubtitleFont,
  type SubtitleSource,
  type SubtitleTrack,
  type SubtitleWindow,
  subtitleLimits,
} from '../../../../../../packages/core/src/media-subtitles.js';

async function remoteWindow(response: Response, time: number): Promise<SubtitleWindow> {
  if (!response.ok || !response.body) throw new Error('Subtitle window unavailable');
  const maximum = 16 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum)
    throw new Error('Subtitle response exceeds limit');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let json = '';
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      received += item.value.length;
      if (received > maximum) throw new Error('Subtitle response exceeds limit');
      json += decoder.decode(item.value, { stream: true });
    }
    json += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object') throw new Error('Invalid subtitle response');
  const window = value as SubtitleWindow;
  if (
    !Number.isFinite(window.start) ||
    !Number.isFinite(window.end) ||
    window.start < 0 ||
    window.start > time ||
    window.end <= time ||
    window.end - window.start > subtitleLimits.windowSeconds + 2 ||
    !Array.isArray(window.cues) ||
    window.cues.length > subtitleLimits.windowCues ||
    window.cues.some(
      (cue) =>
        !cue ||
        typeof cue.id !== 'string' ||
        cue.id.length > 128 ||
        !Number.isFinite(cue.start) ||
        !Number.isFinite(cue.end) ||
        cue.start < 0 ||
        cue.end <= cue.start ||
        cue.end <= window.start ||
        cue.start >= window.end ||
        typeof cue.text !== 'string' ||
        cue.text.length > subtitleLimits.textBytes ||
        (cue.settings !== undefined &&
          (typeof cue.settings !== 'string' || cue.settings.length > subtitleLimits.textBytes)),
    )
  )
    throw new Error('Invalid subtitle response');
  return window;
}

/** Browser index reads stay small. Unindexed ordinary files use the same parser over
 * the existing authorized SFTP handle, avoiding an HTTP request per media packet.
 * Archive members retain the bounded browser fallback; no full-media download.
 */
export async function openSubtitleSource(
  url: string,
  size: number,
  signal: AbortSignal,
): Promise<SubtitleSource | null> {
  const parsed = new URL(url, location.href);
  if (
    parsed.origin !== location.origin ||
    parsed.username ||
    parsed.password ||
    !/^\/v1\/servers\/[^/]+\/files\/viewer\/(?:archive\/)?content$/.test(parsed.pathname) ||
    !Number.isSafeInteger(size) ||
    size < 12
  )
    throw new Error('Invalid subtitle source');
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const source = new MatroskaSubtitles(
    size,
    (readSignal) => new VideoRangeReader(parsed.href, size, readSignal),
    lifetime,
  );
  try {
    if (!(await source.open())) {
      source.dispose();
      return null;
    }
    const ordinaryFile = /\/viewer\/content$/.test(parsed.pathname);
    return {
      tracks: source.tracks,
      fonts: (requestSignal) => source.fonts(requestSignal),
      async readWindow(trackId, time, requestSignal) {
        lifetime.throwIfAborted();
        requestSignal?.throwIfAborted();
        if (!ordinaryFile || source.hasUsableIndex(trackId))
          return source.readWindow(trackId, time, requestSignal);
        if (!source.tracks.some((track) => track.id === trackId && track.supported))
          throw new Error('Unsupported subtitle track');
        if (!Number.isFinite(time) || time < 0) throw new Error('Invalid subtitle time');
        const endpoint = new URL(parsed);
        endpoint.pathname = endpoint.pathname.replace(/\/content$/, '/subtitles');
        endpoint.searchParams.set('track', trackId);
        endpoint.searchParams.set('time', String(time));
        const response = await fetch(endpoint.href, {
          credentials: 'same-origin',
          redirect: 'error',
          signal: AbortSignal.any([
            lifetime,
            ...(requestSignal ? [requestSignal] : []),
            AbortSignal.timeout(subtitleLimits.operationMs),
          ]),
        });
        return remoteWindow(response, time);
      },
      dispose() {
        controller.abort();
        source.dispose();
      },
    };
  } catch (error) {
    controller.abort();
    source.dispose();
    throw error;
  }
}
