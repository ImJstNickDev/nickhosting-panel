import type { OpenworldTelemetryData } from '../../../../../games/openworld/src/telemetry.js';
import { useT } from '../../app/i18n.js';
import { key, numeric, useMetricsFormat } from './telemetry.js';
import './player-hud-fonts.css';
import './player-vitals.css';

type Gauge = 'health' | 'hunger' | 'air';
type Vitals = NonNullable<OpenworldTelemetryData['player']['vitals']> & {
  maxSaturation?: number | null;
};

function GaugeIcon({ kind }: { kind: Gauge }) {
  return (
    <svg className="ow-hud-icon" viewBox="0 0 24 24" shapeRendering="crispEdges" aria-hidden="true">
      {kind === 'health' ? (
        <>
          <path
            fill="#642633"
            d="M1 5h2V3h6v2h2v1h2V5h2V3h6v2h2v9h-2v2h-2v2h-2v2h-2v2H9v-2H7v-2H5v-2H3v-2H1z"
          />
          <path
            fill="#e04255"
            d="M2 6h2V4h4v2h2v2h4V6h2V4h4v2h2v6h-2v2h-2v2h-2v2h-2v2h-4v-2H8v-2H6v-2H4v-2H2z"
          />
          <path fill="#ffbdac" d="M4 6h4v2H6v3H4zM16 6h3v2h-3z" />
        </>
      ) : kind === 'hunger' ? (
        <>
          <path fill="#754322" d="M1 13h2V9h3V7h3V5h7v2h4v3h2v2h1v5h-2v2H4v-2H1z" />
          <path fill="#dd913d" d="M2 13h2v-3h3V8h3V6h5v2h4v2h2v3h1v3h-3v2H5v-2H2z" />
          <path
            fill="#ffda8a"
            d="M4 12h2v-2h2v3h2v2H7v-2H4zm6-5h3v2h1v3h-2V9h-2zm6 2h2v2h2v2h-3v-2h-1z"
          />
        </>
      ) : (
        <>
          <path fill="#276382" d="M8 2h8v2h4v3h2v9h-2v4h-4v2H8v-2H4v-4H2V8h2V5h4z" />
          <path fill="#76cde4" d="M8 4h7v1h4v3h1v7h-2v4h-4v1H9v-2H6v-3H4V9h2V6h2z" />
          <path fill="#dbf9ff" d="M8 6h5v2h-3v2H8v3H6V9h2zM17 14h2v2h-2z" />
        </>
      )}
    </svg>
  );
}

function Fill({
  value,
  max,
  label,
  reserve = false,
}: {
  value: number;
  max: number;
  label: string;
  reserve?: boolean;
}) {
  const current = Math.max(0, Math.min(value, max));
  return (
    <span className={reserve ? 'ow-hud-reserve-scale' : 'ow-hud-scale'}>
      <meter className="visually-hidden" aria-label={label} min={0} max={max} value={current} />
      <span aria-hidden="true" style={{ width: `${(current / max) * 100}%` }} />
    </span>
  );
}

export function PlayerVitals({
  vitals,
  version,
  saved = false,
  observedAt,
}: {
  vitals?: Vitals | null;
  version?: string | null;
  saved?: boolean;
  observedAt?: string;
}) {
  const t = useT(),
    f = useMetricsFormat();
  const maxReserve = vitals?.maxSaturation ?? (version === 'a1.2.9' ? 50 : undefined);
  const gauges = [
    ['health', vitals?.health, vitals?.maxHealth],
    ['hunger', vitals?.hunger, vitals?.maxHunger],
    ['air', vitals?.air, vitals?.maxAir],
  ] as const;
  const hasReadings = gauges.some(([, value]) => numeric(value)) || numeric(vitals?.saturation);
  if (!hasReadings && !saved) return null;
  return (
    <section className="ow-player-hud" aria-label={t('games.openworld.people.vitalStats')}>
      {gauges.map(([kind, value, max]) => {
        const reserve = kind === 'hunger' ? vitals?.saturation : null;
        if (!saved && !numeric(value) && !numeric(reserve)) return null;
        return (
          <div key={kind} className={`ow-hud-gauge ow-hud-${kind}`}>
            <div className="ow-hud-label">
              <span>{t(key(kind))}</span>
              {numeric(value) ? (
                <strong>
                  {f.metric(value)}
                  {numeric(max) && max > 0 ? ` / ${f.metric(max)}` : ''}
                  {kind === 'air' ? ' s' : ''}
                </strong>
              ) : (
                <span>—</span>
              )}
            </div>
            {numeric(value) && numeric(max) && max > 0 && (
              <div className="ow-hud-bar">
                <GaugeIcon kind={kind} />
                <Fill value={value} max={max} label={t(key(kind))} />
                {numeric(reserve) && numeric(maxReserve) && maxReserve > 0 && (
                  <Fill value={reserve} max={maxReserve} label={t(key('saturation'))} reserve />
                )}
              </div>
            )}
            {numeric(reserve) && (
              <small>
                {t(key('saturation'))} <b>{f.metric(reserve)}</b>
              </small>
            )}
          </div>
        );
      })}
      {hasReadings && observedAt && (
        <small className="ow-source-time">
          {t(key('snapshot'))} · <time dateTime={observedAt}>{f.date(observedAt)}</time>
        </small>
      )}
      {!hasReadings && (
        <small className="ow-source-time">{t('games.openworld.people.noRecordedVitals')}</small>
      )}
    </section>
  );
}
