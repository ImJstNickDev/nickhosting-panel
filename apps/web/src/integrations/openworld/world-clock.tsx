import { useLayoutEffect, useRef } from 'react';
import type { OpenworldTelemetryData } from '../../../../../games/openworld/src/telemetry.js';
import { useT } from '../../app/i18n.js';
import { key, numeric } from './telemetry.js';
import { clockAt, dayPhase, observeClock, predictionLimitMs } from './world-clock-motion.js';

// Openworld's 24-hour cycle starts at midnight and crosses the horizon at 06:00 and 18:00.
const cycleHeight = (fraction: number) => 50 + 36 * Math.cos(2 * Math.PI * fraction);
const cycleArcs = [
  { startHour: 0, endHour: 6, phase: 'night' },
  { startHour: 6, endHour: 18, phase: 'day' },
  { startHour: 18, endHour: 24, phase: 'night' },
].map(({ startHour, endHour, phase }) => {
  const points = Array.from({ length: (endHour - startHour) * 4 + 1 }, (_, index) => {
    const fraction = (startHour + index / 4) / 24;
    return `${(fraction * 100).toFixed(2)},${cycleHeight(fraction).toFixed(2)}`;
  }).join(' ');
  return {
    startHour,
    phase,
    points,
    area: `${(startHour / 24) * 100},50 ${points} ${(endHour / 24) * 100},50`,
  };
});

const minuteOfDay = (fraction: number) => Math.floor(fraction * 1440) % 1440;

function clockText(minutes: number) {
  return [Math.floor(minutes / 60), minutes % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function phaseClass(fraction: number) {
  return fraction >= 0.25 && fraction < 0.75 ? 'ow-cycle-day' : 'ow-cycle-night';
}

export function WorldClock({
  status,
  observedAt,
  live,
}: {
  status: OpenworldTelemetryData['status'];
  observedAt: string | null;
  live: boolean;
}) {
  const t = useT();
  const { dayFraction, dayLengthS } = status.worldTime ?? {};
  const { tick, tickBudgetMs } = status;
  const fraction = numeric(dayFraction) ? dayPhase(dayFraction) : null;
  const time = fraction === null ? null : clockText(minuteOfDay(fraction));
  const labelRef = useRef<HTMLTimeElement>(null);
  const pointRef = useRef<SVGCircleElement>(null);
  const motionRef = useRef<ReturnType<typeof observeClock> | null>(null);
  const hiddenSince = useRef<number | null>(null);

  useLayoutEffect(() => {
    const label = labelRef.current;
    const point = pointRef.current;
    if (fraction === null || !label || !point) {
      motionRef.current = null;
      hiddenSince.current = null;
      return;
    }
    let lastMinute = -1;
    const paint = (phase: number) => {
      const minute = minuteOfDay(phase);
      if (minute !== lastMinute) {
        if (lastMinute === -1) {
          label.style.visibility = '';
          point.style.visibility = '';
        }
        const text = clockText(minute);
        if (label.dateTime !== text) {
          label.dateTime = text;
          label.textContent = text;
        }
        point.setAttribute('class', phaseClass(phase));
        lastMinute = minute;
      }
      point.setAttribute('cx', `${phase * 100}%`);
      point.setAttribute('cy', `${cycleHeight(phase)}%`);
    };

    const timestamp = observedAt ? Date.parse(observedAt) : Number.NaN;
    if (!live || !numeric(dayLengthS) || dayLengthS <= 0 || !Number.isFinite(timestamp)) {
      motionRef.current = null;
      hiddenSince.current = null;
      paint(fraction);
      return;
    }
    const now = performance.now();
    const previous = motionRef.current;
    // After a long absence the visible clock starts with a fresh reading. Slewing
    // from hours-old data could keep the displayed time behind for minutes.
    const restart = hiddenSince.current !== null && now - hiddenSince.current >= predictionLimitMs;
    if (restart && previous) {
      const sampleAge = now - previous.receivedAt - (timestamp - previous.reading.observedAt);
      // A pre-suspension request may only finish when the tab is thawed.
      if (timestamp <= previous.reading.observedAt || sampleAge >= predictionLimitMs) {
        label.style.visibility = 'hidden';
        point.style.visibility = 'hidden';
        return;
      }
    }
    if (restart) hiddenSince.current = document.hidden ? now : null;
    const motion = observeClock(
      restart ? null : previous,
      { fraction, dayLengthS, observedAt: timestamp, tick, tickBudgetMs },
      now,
    );
    motionRef.current = motion;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let timer = 0;
    function cancel() {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    }
    function draw() {
      if (document.hidden) return;
      const now = performance.now();
      paint(dayPhase(clockAt(motion, now).position));
      if (now - motion.receivedAt >= predictionLimitMs) return;
      if (reduced.matches) timer = window.setTimeout(draw, 1000);
      else frame = requestAnimationFrame(draw);
    }
    const resume = () => {
      cancel();
      if (document.hidden) {
        hiddenSince.current ??= performance.now();
        return;
      }
      if (
        hiddenSince.current !== null &&
        performance.now() - hiddenSince.current >= predictionLimitMs
      ) {
        label.style.visibility = 'hidden';
        point.style.visibility = 'hidden';
        return;
      }
      hiddenSince.current = null;
      draw();
    };
    resume();
    document.addEventListener('visibilitychange', resume);
    reduced.addEventListener('change', resume);
    return () => {
      cancel();
      document.removeEventListener('visibilitychange', resume);
      reduced.removeEventListener('change', resume);
    };
  }, [fraction, dayLengthS, live, observedAt, tick, tickBudgetMs]);
  return (
    <section className="ow-world-clock">
      <div>
        <h3>{t(key('worldTime'))}</h3>
        {time ? (
          <time ref={labelRef} dateTime={time}>
            {time}
          </time>
        ) : (
          <span>{t('web.unavailable')}</span>
        )}
      </div>
      {fraction !== null && (
        <svg className="ow-cycle" aria-hidden="true" focusable="false">
          <svg
            aria-hidden="true"
            width="100%"
            height="100%"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <line
              x1="0"
              x2="100"
              y1="50"
              y2="50"
              stroke="var(--line)"
              vectorEffect="non-scaling-stroke"
            />
            {cycleArcs.map(({ startHour, phase, points, area }) => (
              <g key={startHour} className={`ow-cycle-${phase}`}>
                <polygon points={area} fill="currentColor" fillOpacity="0.08" />
                <polyline
                  points={points}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}
          </svg>
          <circle
            ref={pointRef}
            className={phaseClass(fraction)}
            cx={`${fraction * 100}%`}
            cy={`${cycleHeight(fraction)}%`}
            r="5"
            fill="currentColor"
            stroke="var(--surface)"
            strokeWidth="2"
          />
        </svg>
      )}
    </section>
  );
}
