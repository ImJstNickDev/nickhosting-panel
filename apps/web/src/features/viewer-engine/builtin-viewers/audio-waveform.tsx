import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { readViewerBytes } from '../core/access.js';
import {
  readWaveformPeak,
  waveformBars,
  waveformEligible,
  waveformLimits,
} from './audio-waveform-model.js';
import './audio-waveform.css';

// Native decodeAudioData cannot be aborted. Keep at most one decode alive across
// viewer changes; canceled queued tasks skip both download and decode.
let analysisQueue: Promise<unknown> = Promise.resolve();
const flatPeaks = new Float32Array(waveformLimits.peaks);
function analyse(
  url: string,
  signal: AbortSignal,
  onPeaks: (peaks: Float32Array) => void,
): Promise<Float32Array> {
  const result = analysisQueue
    .catch(() => {})
    .then(async () => {
      signal.throwIfAborted();
      const bytes = await readViewerBytes(url, waveformLimits.bytes, signal);
      signal.throwIfAborted();
      const context = new OfflineAudioContext(1, 1, 8000);
      const decoded = await context.decodeAudioData(bytes.buffer);
      signal.throwIfAborted();
      if (decoded.duration > waveformLimits.seconds || decoded.numberOfChannels > 8)
        throw new Error('waveform-limit');
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
        decoded.getChannelData(index),
      );
      const count = Math.min(waveformLimits.peaks, decoded.length);
      const peaks = new Float32Array(count);
      for (let index = 0; index < count; index++) {
        peaks[index] = readWaveformPeak(
          channels,
          Math.floor((index * decoded.length) / count),
          Math.floor(((index + 1) * decoded.length) / count),
        );
        if (index % 64 === 63 || index === count - 1) {
          signal.throwIfAborted();
          onPeaks(peaks.slice());
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          signal.throwIfAborted();
        }
      }
      return peaks;
    });
  // This chain retains neither source bytes nor decoded PCM after completion.
  analysisQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

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
  useEffect(() => {
    const controller = new AbortController();
    if (eligibility !== 'eligible') {
      setAnalysis({ url, state: eligibility === 'unavailable' ? 'unavailable' : 'loading' });
      return;
    }
    setAnalysis({ url, state: 'loading' });
    const isCurrent = () => !controller.signal.aborted && currentSource.current === url;
    void analyse(url, controller.signal, (peaks) => {
      if (isCurrent()) setAnalysis({ url, state: 'loading', peaks });
    })
      .then((peaks) => {
        if (isCurrent()) setAnalysis({ url, state: 'ready', peaks });
      })
      .catch(() => {
        if (isCurrent()) setAnalysis({ url, state: 'unavailable' });
      });
    return () => controller.abort();
  }, [url, eligibility]);
  const peaks = analysis.url === url ? analysis.peaks : undefined;
  const bars = useMemo(
    () => waveformBars(peaks ?? flatPeaks, Math.max(1, Math.min(100, Math.floor(width / 7)))),
    [peaks, width],
  );
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
