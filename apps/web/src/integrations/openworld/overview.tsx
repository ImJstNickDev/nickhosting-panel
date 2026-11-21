import { useT } from '../../app/i18n.js';
import {
  key,
  Metrics,
  numeric,
  TelemetryPanel,
  type TelemetryViewProps,
  useMetricsFormat,
  useTelemetry,
  withTelemetrySession,
} from './telemetry.js';

export const OpenworldOverview = withTelemetrySession(Overview);

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

function WorldClock({ dayFraction }: { dayFraction?: number | null }) {
  const t = useT();
  const fraction = numeric(dayFraction) ? dayFraction - Math.floor(dayFraction) : null;
  const minutes = fraction === null ? null : Math.floor(fraction * 24 * 60);
  const time =
    minutes === null
      ? null
      : [Math.floor(minutes / 60), minutes % 60]
          .map((part) => String(part).padStart(2, '0'))
          .join(':');
  return (
    <section className="ow-world-clock">
      <div>
        <h3>{t(key('worldTime'))}</h3>
        {time ? <time dateTime={time}>{time}</time> : <span>{t('web.unavailable')}</span>}
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
            className={fraction >= 0.25 && fraction < 0.75 ? 'ow-cycle-day' : 'ow-cycle-night'}
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

function Overview(props: TelemetryViewProps) {
  const t = useT(),
    f = useMetricsFormat(),
    query = useTelemetry(props, 'status');
  return (
    <div className="ow-workspace">
      <TelemetryPanel title={t(key('overview'))} query={query}>
        {(status) => (
          <>
            <Metrics
              large
              items={[
                [
                  t(key('online')),
                  `${f.metric(status.players.online)} / ${f.metric(status.players.slots)}`,
                ],
                [t(key('tps')), f.metric(status.tps)],
                [t(key('memory')), f.metric(status.memory?.rssMB, 'MB', 0)],
                [t(key('uptime')), f.duration(status.uptimeS)],
              ]}
            />
            <div className="ow-pair">
              <section>
                <h3>{t(key('network'))}</h3>
                <Metrics
                  items={[
                    [t(key('inbound')), f.bitrate(status.net?.recvKbps)],
                    [t(key('outbound')), f.bitrate(status.net?.sentKbps)],
                    [t(key('pingMean')), f.metric(status.pingMs?.mean, 'ms')],
                    [t(key('loss')), f.metric(status.net?.lossPct, '%')],
                  ]}
                />
              </section>
              <section>
                <h3>{t(key('generation'))}</h3>
                <Metrics
                  items={[
                    [t(key('liveChunks')), f.metric(status.chunks?.live)],
                    [t(key('backlog')), f.metric(status.chunks?.genBacklog)],
                    [t(key('generated')), f.metric(status.chunks?.generatedTotal)],
                    [t(key('saved')), f.metric(status.chunks?.savedColumns)],
                  ]}
                />
              </section>
            </div>
            <WorldClock dayFraction={status.worldTime?.dayFraction} />
          </>
        )}
      </TelemetryPanel>
    </div>
  );
}
