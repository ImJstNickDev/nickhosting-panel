import { type RefObject, useEffect, useState } from 'react';

/** Count draws from the active renderer without requesting a frame for the meter itself. */
export function MapFps({
  frames,
  detail,
  trace,
}: {
  frames: RefObject<number | null>;
  detail?: string;
  trace?: string;
}) {
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    let since = performance.now();
    function reset() {
      since = performance.now();
      frames.current = document.hidden ? null : 0;
      setFps(null);
    }
    reset();
    document.addEventListener('visibilitychange', reset);
    const timer = window.setInterval(() => {
      if (frames.current === null) return;
      const now = performance.now();
      setFps(Math.round((frames.current * 1000) / (now - since)));
      frames.current = 0;
      since = now;
    }, 1000);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', reset);
      frames.current = null;
    };
  }, [frames]);
  return (
    <span className="ow-atlas-fps">
      {fps ?? '—'} FPS{detail && ' · '}
      {detail}
      {trace && (
        <>
          {' '}
          · <code className="ow-map-trace">{trace}</code>
        </>
      )}
    </span>
  );
}
