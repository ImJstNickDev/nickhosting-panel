import { type RefObject, useEffect, useRef, useState } from 'react';
import type { MotionTrace } from '../../../../../../packages/core/src/motion-timing.js';
import {
  bufferedContains,
  capturePlayback,
  inspectVideo,
  openVideoInput,
  type PlaybackSnapshot,
  type VideoAudioTrack,
  VideoMseSession,
  videoSourceLimits,
} from './video-mse.js';

export type VideoSourceState = {
  tracks: VideoAudioTrack[];
  selectedId: string | null;
  discovering: boolean;
  switching: boolean;
  error: 'unsupported' | 'failed' | null;
};
const initial: VideoSourceState = {
  tracks: [],
  selectedId: null,
  discovering: true,
  switching: false,
  error: null,
};

/** Owns the single native video source, including abortable compressed-packet MSE alternatives. */
export function useVideoSource({
  media,
  url,
  size,
  trace,
}: {
  media: RefObject<HTMLVideoElement | null>;
  url: string;
  size: number;
  trace?: MotionTrace;
}) {
  const [state, setState] = useState<VideoSourceState>(initial);
  const commands = useRef({ select: (_id: string) => {}, retry: () => {} });
  useEffect(() => {
    const video = media.current;
    if (!video) return;
    const remotePlayback = video.disableRemotePlayback;
    let disposed = false;
    let version = 0;
    let discovery: AbortController | undefined;
    let session: VideoMseSession | undefined;
    let selected: string | null = null;
    let tracks: VideoAudioTrack[] = [];
    let discovering = false;
    let discovered = false;
    let pending: PlaybackSnapshot | undefined;
    let desired: string | null = null;
    const publish = (patch: Partial<VideoSourceState>) => {
      if (!disposed) setState((current) => ({ ...current, ...patch }));
    };
    const replace = (id: string, snapshot: PlaybackSnapshot) => {
      const track = tracks.find((track) => track.id === id);
      if (!track?.supported) {
        publish({ error: 'unsupported' });
        return;
      }
      const attempt = ++version;
      session?.dispose();
      pending = snapshot;
      video.pause();
      desired = id;
      publish({ switching: true, error: null });
      const next = new VideoMseSession({
        media: video,
        url,
        size,
        trackId: id,
        trace,
        snapshot,
        onReady: () => {
          if (disposed || version !== attempt) return;
          selected = id;
          pending = undefined;
          publish({ selectedId: id, switching: false, error: null });
        },
        onError: () => {
          if (disposed || version !== attempt) return;
          // The failed source cannot truthfully continue the previously selected track.
          selected = null;
          publish({ selectedId: null, switching: false, error: 'failed' });
        },
      });
      session = next;
      void next.start();
    };
    const chooseDefault = () => {
      const primary = tracks.find((track) => track.id === desired && track.supported);
      return primary ?? tracks.find((track) => track.supported);
    };
    const nativeError = () => {
      if (session || discovering || !discovered || disposed) return;
      const fallback = chooseDefault();
      if (fallback) replace(fallback.id, capturePlayback(video));
      else if (tracks.length) publish({ error: 'unsupported' });
    };
    const seek = () => {
      if (!session?.ready || !selected || bufferedContains(video.buffered, video.currentTime, 0.05))
        return;
      replace(selected, capturePlayback(video));
    };
    const discover = async () => {
      discovery?.abort();
      const cancellation = new AbortController();
      discovery = cancellation;
      discovering = true;
      discovered = false;
      publish({ discovering: true });
      const timer = window.setTimeout(() => cancellation.abort(), videoSourceLimits.operationMs);
      let opened: ReturnType<typeof openVideoInput> | undefined;
      const finish = trace?.span('video.discovery');
      try {
        opened = openVideoInput(
          trace?.url(url, 'discovery') ?? url,
          size,
          cancellation.signal,
          trace,
        );
        const info = await inspectVideo(opened.input);
        finish?.({
          outcome: cancellation.signal.aborted ? 'cancelled' : 'succeeded',
          count: info.tracks.length,
        });
        if (disposed || discovery !== cancellation || cancellation.signal.aborted) return;
        tracks = info.tracks;
        desired = info.primaryId;
        discovered = true;
        publish({ tracks });
        const preferred = chooseDefault();
        if (tracks.length > 1) {
          if (preferred) replace(preferred.id, capturePlayback(video));
          else if (video.error) publish({ error: 'unsupported' });
        } else if (video.error && preferred) replace(preferred.id, capturePlayback(video));
        else if (tracks.length === 1 && !video.error) {
          // A sole native audio stream is unambiguous; no packet remux is necessary.
          selected = tracks[0]?.id ?? null;
          publish({ selectedId: selected });
        }
      } catch {
        finish?.({ outcome: cancellation.signal.aborted ? 'cancelled' : 'failed' });
        if (!disposed && discovery === cancellation && video.error) publish({ error: 'failed' });
        // Optional discovery failures must not replace working native playback.
      } finally {
        clearTimeout(timer);
        opened?.input.dispose();
        if (!disposed && discovery === cancellation) {
          discovering = false;
          publish({ discovering: false });
        }
      }
    };
    const native = () => {
      ++version;
      session?.dispose();
      session = undefined;
      pending = undefined;
      selected = null;
      desired = null;
      tracks = [];
      setState(initial);
      video.src = url;
      video.load();
      void discover();
    };
    commands.current = {
      select: (id) => {
        if (id === desired && (session || selected === id)) return;
        replace(id, pending ?? capturePlayback(video));
      },
      retry: () => {
        const requested =
          desired && tracks.find((track) => track.id === desired && track.supported);
        if (requested) replace(requested.id, pending ?? capturePlayback(video));
        else native();
      },
    };
    video.addEventListener('error', nativeError);
    video.addEventListener('seeking', seek);
    native();
    return () => {
      disposed = true;
      ++version;
      commands.current = { select: () => {}, retry: () => {} };
      discovery?.abort();
      session?.dispose();
      video.removeEventListener('error', nativeError);
      video.removeEventListener('seeking', seek);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.disableRemotePlayback = remotePlayback;
    };
  }, [media, url, size, trace]);
  return {
    ...state,
    select: (id: string) => commands.current.select(id),
    retry: () => commands.current.retry(),
  };
}
