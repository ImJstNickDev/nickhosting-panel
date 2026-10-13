import { type RefObject, useEffect, useRef, useState } from 'react';
import type { MotionTrace } from '../../../../../../packages/core/src/motion-timing.js';
import type { SubtitleRenderer } from './subtitle-renderer.js';
import type { SubtitleSource, SubtitleTrack, SubtitleWindow } from './subtitle-source.js';

type SubtitleState = {
  tracks: SubtitleTrack[];
  selectedId: string | null;
  error: boolean;
};
const initial: SubtitleState = { tracks: [], selectedId: null, error: false };

/** Optional captions never own or replace the native video/audio source. */
export function useVideoSubtitles({
  media,
  container,
  url,
  size,
  name,
  trace,
}: {
  media: RefObject<HTMLVideoElement | null>;
  container: RefObject<HTMLDivElement | null>;
  url: string;
  size: number;
  name: string;
  trace?: MotionTrace;
}) {
  const [state, setState] = useState<SubtitleState>(initial);
  const commands = useRef({ select: (_id: string | null) => {}, retry: () => {} });
  useEffect(() => {
    const video = media.current;
    const overlay = container.current;
    if (!video || !overlay) return;
    setState(initial);
    // Mediabunny handles audio/video. Subtitle input currently supports Matroska only.
    if (!/\.(mkv|webm)$/i.test(name)) return;
    const lifetime = new AbortController();
    let source: SubtitleSource | null = null;
    let renderer: SubtitleRenderer | null = null;
    let window: SubtitleWindow | null = null;
    let read: AbortController | null = null;
    let setup: AbortController | null = null;
    let selected: string | null = null;
    let generation = 0;
    const publish = (patch: Partial<SubtitleState>) => {
      if (!lifetime.signal.aborted) setState((current) => ({ ...current, ...patch }));
    };
    const fail = (attempt: number) => {
      if (attempt !== generation || lifetime.signal.aborted) return;
      ++generation;
      setup?.abort();
      read?.abort();
      read = null;
      renderer?.destroy();
      renderer = null;
      window = null;
      publish({ error: true });
    };
    const load = async () => {
      if (!source || !selected || !renderer || read) return;
      const time = video.currentTime;
      if (!Number.isFinite(time)) return;
      if (window && time >= window.start && time < window.end - 3) return;
      const attempt = generation;
      const cancellation = new AbortController();
      read = cancellation;
      let finish = trace?.span('subtitles.window');
      let apply: ReturnType<MotionTrace['span']> | undefined;
      try {
        const next = await source.readWindow(selected, time, cancellation.signal);
        finish?.({
          outcome: cancellation.signal.aborted ? 'cancelled' : 'succeeded',
          count: next.cues.length,
          mediaSeconds: time,
        });
        finish = undefined;
        if (attempt !== generation || cancellation.signal.aborted || lifetime.signal.aborted)
          return;
        apply = trace?.span('subtitles.apply');
        await renderer?.setWindow(next);
        apply?.({
          outcome: cancellation.signal.aborted ? 'cancelled' : 'succeeded',
          count: next.cues.length,
        });
        apply = undefined;
        if (attempt === generation && !cancellation.signal.aborted) window = next;
      } catch {
        const outcome =
          cancellation.signal.aborted || lifetime.signal.aborted ? 'cancelled' : 'failed';
        finish?.({ outcome });
        apply?.({ outcome });
        if (!cancellation.signal.aborted) fail(attempt);
      } finally {
        if (read === cancellation) read = null;
      }
    };
    const select = async (id: string | null) => {
      const attempt = ++generation;
      setup?.abort();
      const initialization = new AbortController();
      setup = initialization;
      const signal = AbortSignal.any([lifetime.signal, initialization.signal]);
      read?.abort();
      read = null;
      renderer?.destroy();
      renderer = null;
      window = null;
      selected = id;
      publish({ selectedId: id, error: false });
      if (!id || !source) return;
      const track = source.tracks.find((track) => track.id === id && track.supported);
      if (!track) {
        fail(attempt);
        return;
      }
      const finish = trace?.span('subtitles.renderer');
      let rendererReady: ReturnType<MotionTrace['span']> | undefined;
      const imported = trace?.span('subtitles.renderer_import');
      const fontsReady = trace?.span('subtitles.fonts');
      try {
        const [{ createSubtitleRenderer }, fonts] = await Promise.all([
          import('./subtitle-renderer.js').then(
            (module) => {
              imported?.({ outcome: signal.aborted ? 'cancelled' : 'succeeded' });
              return module;
            },
            (error: unknown) => {
              imported?.({ outcome: signal.aborted ? 'cancelled' : 'failed' });
              throw error;
            },
          ),
          Promise.resolve(
            track.format === 'ass' || track.format === 'ssa' ? source.fonts(signal) : [],
          ).then(
            (fonts) => {
              fontsReady?.({
                outcome: signal.aborted ? 'cancelled' : 'succeeded',
                count: fonts.length,
              });
              return fonts;
            },
            (error: unknown) => {
              fontsReady?.({ outcome: signal.aborted ? 'cancelled' : 'failed' });
              throw error;
            },
          ),
        ]);
        if (attempt !== generation || lifetime.signal.aborted) {
          finish?.({ outcome: 'cancelled' });
          return;
        }
        rendererReady = trace?.span('subtitles.renderer_setup');
        const next = await createSubtitleRenderer({
          media: video,
          container: overlay,
          track,
          fonts: fonts.map((font) => font.data),
          signal,
          onError: () => fail(attempt),
        });
        rendererReady?.({ outcome: signal.aborted ? 'cancelled' : 'succeeded' });
        rendererReady = undefined;
        if (attempt !== generation || lifetime.signal.aborted) {
          finish?.({ outcome: 'cancelled' });
          next.destroy();
          return;
        }
        renderer = next;
        finish?.({ outcome: 'succeeded' });
        await load();
      } catch {
        const outcome = signal.aborted ? 'cancelled' : 'failed';
        rendererReady?.({ outcome });
        finish?.({ outcome });
        fail(attempt);
      }
    };
    const discover = async () => {
      publish({ error: false });
      const finish = trace?.span('subtitles.discovery');
      try {
        const { openSubtitleSource } = await import('./subtitle-source.js');
        const next = await openSubtitleSource(url, size, lifetime.signal, trace);
        finish?.({
          outcome: lifetime.signal.aborted ? 'cancelled' : 'succeeded',
          count: next?.tracks.length ?? 0,
        });
        if (lifetime.signal.aborted) {
          next?.dispose();
          return;
        }
        source = next;
        const tracks = source?.tracks ?? [];
        publish({ tracks });
        const preferred =
          tracks.find((track) => track.supported && track.forced) ??
          tracks.find((track) => track.supported && track.default);
        await select(preferred?.id ?? null);
      } catch {
        finish?.({ outcome: lifetime.signal.aborted ? 'cancelled' : 'failed' });
        publish({ error: true });
      }
    };
    const update = () => void load();
    const seek = () => {
      read?.abort();
      read = null;
      window = null;
      // Clear the previous position while the newly requested window is arriving.
      const attempt = generation;
      void renderer?.setWindow({ start: 0, end: 0, cues: [] }).catch(() => fail(attempt));
      void load();
    };
    commands.current = {
      select: (id) => void select(id),
      retry: () => void (source ? select(selected) : discover()),
    };
    video.addEventListener('timeupdate', update);
    video.addEventListener('seeking', seek);
    video.addEventListener('loadedmetadata', seek);
    void discover();
    return () => {
      ++generation;
      lifetime.abort();
      setup?.abort();
      read?.abort();
      renderer?.destroy();
      source?.dispose();
      commands.current = { select: () => {}, retry: () => {} };
      video.removeEventListener('timeupdate', update);
      video.removeEventListener('seeking', seek);
      video.removeEventListener('loadedmetadata', seek);
    };
  }, [media, container, url, size, name, trace]);
  return {
    ...state,
    select: (id: string | null) => commands.current.select(id),
    retry: () => commands.current.retry(),
  };
}
