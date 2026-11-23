import { type KeyboardEvent, type PointerEvent, useId, useMemo, useRef, useState } from 'react';
import { useLocale, useT } from '../../app/i18n.js';
import {
  type History,
  nearestSample,
  orderedSamples,
  plotPercent,
  seriesPath,
  valueAxis,
} from './history-plot.js';
import { key, numeric } from './telemetry.js';
import './history.css';

const performanceMetrics = {
  timing: {
    unit: 'ms',
    fields: [
      ['tickMean', 'tickMean'],
      ['tickP99', 'tickP99'],
    ],
  },
  network: {
    unit: 'kb/s',
    fields: [
      ['recvKbps', 'inbound'],
      ['sentKbps', 'outbound'],
    ],
  },
  tps: { unit: 'TPS', fields: [['tps', 'tps']] },
  pingMean: { unit: 'ms', fields: [['pingMean', 'pingMean']] },
  creatures: { unit: '', fields: [['creatures', 'creatures']] },
  liveChunks: { unit: '', fields: [['liveChunks', 'liveChunks']] },
  generationRate: { unit: '/s', fields: [['genPerS', 'generationRate']] },
  simulationRate: { unit: '/s', fields: [['simPerS', 'simulationRate']] },
  population: { unit: '', fields: [['players', 'players']] },
} as const;

export type HistoryMetrics = Record<
  string,
  { unit: string; fields: readonly (readonly [string, string])[] }
>;
type Pin = { history: History; index: number; start: number; end: number };
type Gesture = { history: History; pointerId: number; clientX: number; from: number; to: number };

const timeMarks = [0, 25, 50, 75, 100];

function formats(locale: string) {
  const tag = locale === 'it' ? 'it-IT' : 'en-GB';
  const options = { hour: '2-digit', minute: '2-digit', second: '2-digit' } as const;
  const clock = new Intl.DateTimeFormat(tag, options);
  const precise = new Intl.DateTimeFormat(tag, { ...options, fractionalSecondDigits: 3 });
  const date = new Intl.DateTimeFormat(tag, { dateStyle: 'medium' });
  const fraction = new Intl.NumberFormat(tag, { maximumSignificantDigits: 6 });
  const integer = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });
  const scientific = new Intl.NumberFormat(tag, {
    notation: 'scientific',
    maximumSignificantDigits: 5,
  });
  return {
    time: (stamp: number, milliseconds = false) => (milliseconds ? precise : clock).format(stamp),
    date: (stamp: number) => date.format(stamp),
    metric: (value: number | null | undefined, unit: string) => {
      if (!numeric(value)) return '—';
      const size = Math.abs(value);
      const formatter =
        size >= 1e12 || (size > 0 && size < 1e-6)
          ? scientific
          : Number.isInteger(value)
            ? integer
            : fraction;
      const number = formatter.format(value);
      return unit ? `${number} ${unit}` : number;
    },
  };
}

export function HistoryChart({
  history,
  isLive,
  groups = performanceMetrics,
  firstMetric = 'timing',
  metricKey = key,
  guides,
}: {
  history: History;
  isLive: boolean;
  groups?: HistoryMetrics;
  firstMetric?: string;
  metricKey?: (name: string) => string;
  guides?: Record<string, { label: string; value: number; aboveScaleLabel?: string }>;
}) {
  const t = useT();
  const { locale } = useLocale();
  const f = useMemo(() => formats(locale), [locale]);
  const hintId = useId();
  const keysId = useId();
  const control = useRef<HTMLInputElement>(null);
  const metricSelect = useRef<HTMLSelectElement>(null);
  const [group, setGroup] = useState(firstMetric);
  // One immutable, bounded response keeps the complete sample and its context as live data rolls.
  const [pin, setPin] = useState<Pin | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const source = gesture?.history ?? pin?.history ?? history;
  const samples = useMemo(() => orderedSamples(source), [source]);
  const start = pin?.start ?? 0;
  const end = pin?.end ?? samples.length - 1;
  const visible = useMemo(() => samples.slice(start, end + 1), [samples, start, end]);
  const first = visible[0]?.stamp ?? 0;
  const last = visible.at(-1)?.stamp ?? first;
  const { fields, unit } = groups[group] ?? performanceMetrics.timing;
  const guide = guides?.[group];
  const guideValue = guide?.value;
  const allowOffscale = Boolean(guide?.aboveScaleLabel);
  const plot = useMemo(() => {
    const values = fields
      .flatMap(([field]) => visible.map(({ row }) => source[field]?.[row]))
      .filter(numeric);
    // A distant budget would flatten normal step timings. Keep it in the legend.
    const guideInRange =
      numeric(guideValue) && (!allowOffscale || guideValue <= 2.2 * Math.max(0, ...values));
    const axis = valueAxis(guideInRange ? [...values, guideValue] : values, unit === '');
    const x = (stamp: number) => plotPercent(stamp, first, last);
    const y = (value: number) => 100 - plotPercent(value, axis.low, axis.high);
    const lines = fields.map(([field, label]) => ({
      field,
      label,
      path: seriesPath(visible, source[field], x, y),
    }));
    return { axis, x, y, lines, guideInRange, hasValues: values.length > 0 };
  }, [fields, unit, source, visible, first, last, guideValue, allowOffscale]);

  const hoverIndex =
    hover !== null && hover >= first && hover <= last
      ? nearestSample(samples, hover, start, end)
      : end;
  const index = gesture?.to ?? pin?.index ?? hoverIndex;
  const sample = samples[index];
  const stamp = sample?.stamp ?? last;
  const sampleTime = f.time(stamp, stamp % 1000 !== 0);
  const sampleDate = f.date(stamp);
  const readout = plot.lines.map(({ field, label }) => ({
    field,
    label: t(metricKey(label)),
    value: f.metric(sample ? source[field]?.[sample.row] : null, unit),
  }));
  const zoomed = start !== 0 || end !== samples.length - 1;
  const dragAnchor = gesture && samples[gesture.from];
  const anchorX = dragAnchor ? plot.x(dragAnchor.stamp) : null;
  const cursorX = plot.x(stamp);

  function pinAt(index: number, from = start, to = end) {
    setPin({ history: source, index, start: from, end: to });
    setHover(null);
  }
  function resume() {
    setPin(null);
    setHover(null);
    setGesture(null);
    (control.current ?? metricSelect.current)?.focus();
  }
  function zoomIn() {
    const size = Math.max(2, Math.ceil(visible.length / 2));
    const from = Math.max(start, Math.min(end - size + 1, index - Math.floor(size / 2)));
    pinAt(index, from, from + size - 1);
  }
  function pointerIndex(e: PointerEvent<HTMLInputElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return nearestSample(samples, first + (last - first) * frac, start, end);
  }
  function pointerDown(e: PointerEvent<HTMLInputElement>) {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    const at = pointerIndex(e);
    setGesture({ history: source, pointerId: e.pointerId, clientX: e.clientX, from: at, to: at });
  }
  function pointerMove(e: PointerEvent<HTMLInputElement>) {
    if (!e.isPrimary) return;
    const at = pointerIndex(e);
    if (gesture?.pointerId === e.pointerId) {
      if (gesture.to !== at) setGesture({ ...gesture, to: at });
    } else if (!pin && e.pointerType !== 'touch') {
      setHover(samples[at]?.stamp ?? null);
    }
  }
  function pointerUp(e: PointerEvent<HTMLInputElement>) {
    if (gesture?.pointerId !== e.pointerId) return;
    const at = pointerIndex(e);
    if (at !== gesture.from && Math.abs(e.clientX - gesture.clientX) >= 8) {
      const from = Math.min(gesture.from, at);
      const to = Math.max(gesture.from, at);
      pinAt(Math.max(from, Math.min(to, pin?.index ?? at)), from, to);
    } else {
      pinAt(at);
    }
    setGesture(null);
  }
  function keyDown(e: KeyboardEvent<HTMLInputElement>) {
    const position: Record<string, number> = {
      ArrowLeft: index - 1,
      ArrowDown: index - 1,
      ArrowRight: index + 1,
      ArrowUp: index + 1,
      Home: start,
      End: end,
      Enter: index,
      ' ': index,
    };
    const next = position[e.key];
    if (e.key === 'Escape' && pin) {
      e.preventDefault();
      resume();
    } else if (typeof next === 'number') {
      e.preventDefault();
      pinAt(Math.min(end, Math.max(start, next)));
    }
  }
  const state = pin
    ? 'historyPinned'
    : gesture || hover !== null
      ? 'historySample'
      : 'historyLatest';
  const range = t(key('chartRange'), { start: f.time(first), end: f.time(last) });
  return (
    <div className="ow-history">
      <div className="ow-history-toolbar">
        <label className="ow-metric-select">
          {t(key('metric'))}
          <select ref={metricSelect} value={group} onChange={(e) => setGroup(e.target.value)}>
            {Object.keys(groups).map((item) => (
              <option key={item} value={item}>
                {t(metricKey(item))}
              </option>
            ))}
          </select>
        </label>
        {(plot.hasValues || zoomed) && (
          <div className="ow-history-zoom">
            <button
              className="secondary"
              type="button"
              disabled={!plot.hasValues || visible.length <= 2}
              onClick={zoomIn}
            >
              {t(key('historyZoomIn'))}
            </button>
            {zoomed && (
              <button
                className="secondary"
                type="button"
                onClick={() => pinAt(index, 0, samples.length - 1)}
              >
                {t(key('historyResetZoom'))}
              </button>
            )}
          </div>
        )}
      </div>
      {plot.hasValues ? (
        <>
          <div className="ow-history-chart">
            <div className="ow-history-y" aria-hidden="true">
              {[...plot.axis.ticks].reverse().map((v) => (
                <span key={v}>{f.metric(v, unit)}</span>
              ))}
            </div>
            <div className="ow-history-plot">
              <svg
                role="img"
                aria-label={`${t(metricKey(group))} · ${range}`}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <title>{t(metricKey(group))}</title>
                {plot.axis.ticks.map((v) => (
                  <line
                    key={v}
                    className="ow-history-grid"
                    x1="0"
                    x2="100"
                    y1={plot.y(v)}
                    y2={plot.y(v)}
                  />
                ))}
                {timeMarks.map((v) => (
                  <line
                    key={v}
                    className="ow-history-grid ow-vertical"
                    x1={v}
                    x2={v}
                    y1="0"
                    y2="100"
                  />
                ))}
                {anchorX !== null && anchorX !== cursorX && (
                  <rect
                    className="ow-history-brush"
                    y="0"
                    height="100"
                    x={Math.min(anchorX, cursorX)}
                    width={Math.abs(anchorX - cursorX)}
                  />
                )}
                {guide && plot.guideInRange && (
                  <line
                    className="ow-history-guide"
                    x1="0"
                    x2="100"
                    y1={plot.y(guide.value)}
                    y2={plot.y(guide.value)}
                  >
                    <title>
                      {guide.label} · {f.metric(guide.value, unit)}
                    </title>
                  </line>
                )}
                {plot.lines.map(({ field, path }, i) => (
                  <path
                    key={field}
                    className={i ? 'ow-history-line ow-alt' : 'ow-history-line'}
                    d={path}
                  />
                ))}
                <line className="ow-history-crosshair" x1={cursorX} x2={cursorX} y1="0" y2="100" />
              </svg>
              {sample &&
                plot.lines.map(({ field }, i) => {
                  const v = source[field]?.[sample.row];
                  return (
                    numeric(v) && (
                      <i
                        aria-hidden="true"
                        className={i ? 'ow-history-dot ow-alt' : 'ow-history-dot'}
                        key={field}
                        style={{ left: `${cursorX}%`, top: `${plot.y(v)}%` }}
                      />
                    )
                  );
                })}
              <input
                ref={control}
                type="range"
                className="ow-history-control"
                aria-label={t(key('historySample'))}
                aria-describedby={`${hintId} ${keysId}`}
                min={start}
                max={end}
                value={index}
                aria-valuetext={[
                  `${sampleDate} · ${sampleTime}`,
                  ...readout.map((r) => `${r.label} ${r.value}`),
                ].join(', ')}
                onChange={(e) => pinAt(e.currentTarget.valueAsNumber)}
                onKeyDown={keyDown}
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={() => setGesture(null)}
                onLostPointerCapture={() => setGesture(null)}
                onPointerLeave={() => setHover(null)}
              />
            </div>
            <div className="ow-history-x" aria-hidden="true">
              {(first === last ? [50] : timeMarks).map((v) => {
                const marker = first + ((last - first) * v) / 100;
                return (
                  <span key={v} style={{ left: `${v}%` }}>
                    {f.time(marker, last - first < 4000 && marker % 1000 !== 0)}
                  </span>
                );
              })}
            </div>
          </div>
          <p className="ow-history-hint" id={hintId}>
            {t(key('historyHint'))}
          </p>
          <span className="visually-hidden" id={keysId}>
            {t(key('historyKeys'))}
          </span>
        </>
      ) : (
        <p className="ow-empty">{t(key('noHistory'))}</p>
      )}
      {(plot.hasValues || pin) && (
        <div className="ow-history-readout">
          <div className="ow-history-at">
            <span>{t(key(state))}</span>
            <time dateTime={new Date(stamp).toISOString()} title={sampleDate}>
              {sampleTime}
            </time>
          </div>
          <dl className="ow-legend">
            {readout.map(({ field, label, value }, i) => (
              <div key={field}>
                <dt>
                  <i className={i ? 'ow-alt' : ''} />
                  {label}
                </dt>
                <dd>{value}</dd>
              </div>
            ))}
            {guide && (
              <div>
                <dt>
                  <i className="ow-guide-key" />
                  {guide.label}
                </dt>
                <dd>
                  {f.metric(guide.value, unit)}
                  {!plot.guideInRange && guide.aboveScaleLabel && ` · ${guide.aboveScaleLabel}`}
                </dd>
              </div>
            )}
          </dl>
          {pin && (
            <button type="button" className="secondary ow-history-resume" onClick={resume}>
              {t(key(isLive ? 'historyResume' : 'historyReturnLatest'))}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
