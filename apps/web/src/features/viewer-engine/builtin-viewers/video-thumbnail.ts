import { useEffect, useRef, useState } from 'react';
import { safeApiPath } from '../../../api/client.js';
import {
  type ThumbnailReply,
  ThumbnailSession,
  thumbnailBucket,
  thumbnailLimits,
  type VideoThumbnail,
} from './video-thumbnail-model.js';

/** Optional previews never share a decoder, readiness state, or playback clock with the video. */
export function useVideoThumbnail({
  url,
  size,
  time,
}: {
  url: string;
  size: number;
  time: number | null;
}): VideoThumbnail | undefined {
  const current = useRef({ url, size, time });
  current.current = { url, size, time };
  const controller = useRef<{ update: (time: number | null) => void } | undefined>(undefined);
  const [result, setResult] = useState<{
    url: string;
    size: number;
    bucket: number | undefined;
    image: VideoThumbnail | undefined;
  }>();

  useEffect(() => {
    const session = new ThumbnailSession();
    let worker: Worker | undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let lastSent = -Infinity;
    const publish = () => {
      if (stopped || current.current.url !== url || current.current.size !== size) return;
      setResult({
        url,
        size,
        bucket: thumbnailBucket(current.current.time),
        image: session.read(),
      });
    };
    const suspend = () => {
      clearTimeout(timer);
      clearTimeout(deadline);
      timer = undefined;
      session.cancelPending();
      if (!worker) return;
      const closing = worker;
      worker = undefined;
      const timeout = setTimeout(() => closing.terminate(), 1_000);
      const terminate = () => {
        clearTimeout(timeout);
        closing.terminate();
      };
      closing.onmessage = (event: MessageEvent<ThumbnailReply>) => {
        if (event.data.type === 'cancelled') terminate();
      };
      closing.onerror = closing.onmessageerror = terminate;
      // Abort fetch and dispose Input inside the worker before termination (also in Firefox).
      closing.postMessage({ type: 'cancel' });
    };
    const dispose = () => {
      if (stopped) return;
      stopped = true;
      suspend();
      session.dispose();
    };
    const fail = () => {
      if (current.current.url === url && current.current.size === size) setResult(undefined);
      dispose();
    };
    const flush = () => {
      timer = undefined;
      if (stopped || document.hidden) return;
      const request = session.next();
      if (!request) return;
      try {
        if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid video size');
        const source = new URL(safeApiPath(url), window.location.origin).href;
        if (!worker) {
          worker = new Worker(new URL('./video-thumbnail-worker.ts', import.meta.url), {
            type: 'module',
          });
          worker.onmessage = (event: MessageEvent<ThumbnailReply>) => {
            if (stopped) return;
            clearTimeout(deadline);
            const reply = event.data;
            if (reply.type === 'error') {
              fail();
              return;
            }
            if (reply.type === 'cancelled') return;
            session.want(current.current.time);
            session.complete(reply);
            publish();
            schedule();
          };
          worker.onerror = worker.onmessageerror = fail;
        }
        lastSent = performance.now();
        // The main-thread watchdog also bounds a worker stuck parsing malformed metadata.
        deadline = setTimeout(fail, thumbnailLimits.requestMs);
        worker.postMessage({ type: 'thumbnail', url: source, size, ...request });
      } catch {
        fail();
      }
    };
    const schedule = () => {
      if (stopped || timer !== undefined) return;
      timer = setTimeout(
        flush,
        Math.max(0, thumbnailLimits.intervalMs - (performance.now() - lastSent)),
      );
    };
    controller.current = {
      update: (nextTime) => {
        const activeTime = document.hidden ? null : nextTime;
        if (activeTime === null) suspend();
        session.want(activeTime);
        publish();
        if (activeTime !== null) schedule();
      },
    };
    const onVisibility = () => {
      if (document.hidden) {
        suspend();
        setResult(undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    controller.current.update(current.current.time);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      controller.current = undefined;
      dispose();
    };
  }, [url, size]);

  useEffect(() => {
    controller.current?.update(time);
  }, [time]);
  return time !== null &&
    result?.url === url &&
    result.size === size &&
    result.bucket === thumbnailBucket(time)
    ? result.image
    : undefined;
}
