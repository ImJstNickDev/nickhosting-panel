import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { safeApiPath } from '../../../api/client.js';
import { useT } from '../../../app/i18n.js';
import { waveformBars, waveformEligible, waveformLimits } from './audio-waveform-model.js';
import { useWaveformReveal } from './audio-waveform-reveal.js';
import './audio-waveform.css';

const flatPeaks = new Float32Array(waveformLimits.peaks);

export function AudioWaveform({
  url,
  size,
  duration,
  position,
  unavailable = false,
}: {
  url: string;
  size: number;
  duration: number;
  position: number;
  unavailable?: boolean;
}) {
  const t = useT();
  const clip = useId();
  const root = useRef<HTMLDivElement>(null);
  const currentSource = useRef(url);
  currentSource.current = url;
  const [width, setWidth] = useState(600);
  const [analysis, setAnalysis] = useState<{
    url: string;
    state: 'loading' | 'ready' | 'unavailable';
    peaks?: Float32Array;
  }>({ url, state: 'loading' });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const eligibility = unavailable
    ? 'unavailable'
    : waveformEligible(size, duration)
      ? 'eligible'
      : duration > 0
        ? 'unavailable'
        : 'pending';
  // Metadata may refine duration during playback; do not restart analysis within
  // the same eligibility window. The worker receives the latest initial values.
  const input = useRef({ size, duration });
  input.current = { size, duration };
  useEffect(() => {
    if (eligibility !== 'eligible') {
      setAnalysis({ url, state: eligibility === 'unavailable' ? 'unavailable' : 'loading' });
      return;
    }
    setAnalysis({ url, state: 'loading' });
    let worker: Worker | undefined;
    let active = true;
    let disposed = false;
    const dispose = () => {
      if (!worker || disposed) return;
      disposed = true;
      const closingWorker = worker;
      // Firefox can retain a worker's fetch after terminate(). Abort in the
      // worker first, then release it once cancellation is acknowledged.
      const timeout = window.setTimeout(() => closingWorker.terminate(), 1_000);
      closingWorker.onmessage = (event: MessageEvent<{ type: string }>) => {
        if (event.data.type !== 'cancelled') return;
        window.clearTimeout(timeout);
        closingWorker.terminate();
      };
      closingWorker.onerror = closingWorker.onmessageerror = () => {
        window.clearTimeout(timeout);
        closingWorker.terminate();
      };
      closingWorker.postMessage({ type: 'cancel' });
    };
    const fail = () => {
      if (active && currentSource.current === url) setAnalysis({ url, state: 'unavailable' });
      active = false;
      dispose();
    };
    try {
      worker = new Worker(new URL('./audio-waveform-worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (
        event: MessageEvent<{ type: 'peaks' | 'done' | 'error'; peaks?: Float32Array }>,
      ) => {
        if (!active || currentSource.current !== url) return;
        if (event.data.type === 'error' || !event.data.peaks) {
          fail();
          return;
        }
        setAnalysis({
          url,
          state: event.data.type === 'done' ? 'ready' : 'loading',
          peaks: event.data.peaks,
        });
        if (event.data.type === 'done') dispose();
      };
      worker.onerror = fail;
      worker.onmessageerror = fail;
      worker.postMessage({
        url: new URL(safeApiPath(url), window.location.origin).href,
        ...input.current,
      });
    } catch {
      fail();
    }
    return () => {
      active = false;
      dispose();
    };
  }, [url, eligibility]);
  const peaks = analysis.url === url ? analysis.peaks : undefined;
  const bars = useMemo(
    () => waveformBars(peaks ?? flatPeaks, Math.max(1, Math.min(100, Math.floor(width / 7)))),
    [peaks, width],
  );
  useWaveformReveal(root, url, bars);
  const state = analysis.url === url ? analysis.state : 'loading';
  const progress =
    Number.isFinite(position) && duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
  const barWidth = Math.min(6, 500 / Math.max(1, bars.length));
  const barElements = useMemo(
    () =>
      bars.map((peak, index) => {
        const height = Math.max(2, Math.sqrt(peak) * 110);
        const x = ((index + 0.5) / bars.length) * 1000 - barWidth / 2;
        return (
          <rect
            key={x}
            className="wave-envelope-bar"
            data-wave-bar={index}
            data-amplitude={peak}
            data-height={height}
            x={x}
            y="9"
            width={barWidth}
            height="110"
            rx={barWidth / 2}
            style={{ transform: `scaleY(${height / 110})` }}
          />
        );
      }),
    [bars, barWidth],
  );
  return (
    <div ref={root} className="wave-envelope" data-waveform-state={state} aria-hidden="true">
      {state !== 'unavailable' ? (
        <svg viewBox="0 0 1000 128" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath id={clip}>
              <rect width={progress * 1000} height="128" />
            </clipPath>
          </defs>
          <g className="wave-envelope-unplayed">{barElements}</g>
          <g className="wave-envelope-played" clipPath={`url(#${clip})`}>
            {barElements}
          </g>
        </svg>
      ) : (
        <>
          <div className="wave-envelope-rail" />
          <span>{t('viewer.waveformUnavailable')}</span>
        </>
      )}
    </div>
  );
}
