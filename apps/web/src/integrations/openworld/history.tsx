import { useState } from 'react';
import type { OpenworldTelemetryData } from '../../../../../games/openworld/src/telemetry.js';
import { useLocale, useT } from '../../app/i18n.js';
import { key, numeric, useMetricsFormat } from './telemetry.js';

const groups = {
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

export function HistoryChart({ history }: { history: OpenworldTelemetryData['history'] }) {
  const [group, setGroup] = useState<keyof typeof groups>('timing');
  const t = useT(),
    { locale } = useLocale(),
    f = useMetricsFormat();
  const { unit, fields } = groups[group];
  const origin = history.t[0] ?? 0,
    end = history.t.at(-1) ?? origin;
  const scale = Math.max(1, end - origin);
  const series = fields.map(([field, label]) => ({
    label: t(key(label)),
    values: history[field] ?? [],
  }));
  const values = series.flatMap((s) => s.values).filter(numeric);
  const max = Math.max(...values, 1);
  const clock = (stamp: number) =>
    Number.isFinite(new Date(stamp).getTime())
      ? new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(stamp)
      : '—';
  return (
    <div className="ow-history">
      <label className="ow-metric-select">
        {t(key('metric'))}
        <select value={group} onChange={(e) => setGroup(e.target.value as keyof typeof groups)}>
          {(Object.keys(groups) as (keyof typeof groups)[]).map((item) => (
            <option key={item} value={item}>
              {t(key(item))}
            </option>
          ))}
        </select>
      </label>
      {!values.length ? (
        <p className="ow-empty">{t(key('noHistory'))}</p>
      ) : (
        <>
          <div className="ow-graph">
            <div className="ow-y-labels" aria-hidden="true">
              <span>{f.metric(max, unit)}</span>
              <span>{f.metric(max / 2, unit)}</span>
              <span>{f.metric(0, unit)}</span>
            </div>
            <svg
              role="img"
              aria-label={`${t(key(group))} · ${t(key('chartRange'), { start: clock(origin), end: clock(end) })}`}
              viewBox="0 0 600 110"
              preserveAspectRatio="none"
            >
              <title>{t(key(group))}</title>
              {[3, 55, 107].map((y) => (
                <line
                  key={y}
                  x1="0"
                  x2="600"
                  y1={y}
                  y2={y}
                  stroke="var(--line)"
                  strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {series.map(({ label, values: points }, index) => {
                const color = index === 0 ? 'var(--ow-primary)' : 'var(--ow-secondary)';
                let d = '',
                  last = -2;
                points.forEach((value, i) => {
                  if (!numeric(value) || !numeric(history.t[i])) return;
                  const x = ((history.t[i] - origin) / scale) * 596 + 2,
                    y = 107 - (value / max) * 104;
                  // A short horizontal stroke makes isolated samples visible without joining gaps.
                  d +=
                    last === i - 1
                      ? ` L${x.toFixed(2)},${y.toFixed(2)}`
                      : ` M${x.toFixed(2)},${y.toFixed(2)}h0.2`;
                  last = i;
                });
                return (
                  <path
                    key={label}
                    d={d}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </svg>
          </div>
          <div className="ow-x-labels">
            {[origin, end].map((v, i) => (
              <span key={i === 0 ? 'start' : 'end'}>{clock(v)}</span>
            ))}
          </div>
          <dl className="ow-legend">
            {series.map(({ label, values: points }, i) => (
              <div key={label}>
                <dt>
                  <i className={i === 1 ? 'ow-alt' : ''} />
                  {label}
                </dt>
                <dd>{f.metric(points.at(-1), unit)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  );
}
