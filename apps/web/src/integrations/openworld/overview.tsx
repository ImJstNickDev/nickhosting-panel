import { useT } from '../../app/i18n.js';
import {
  key,
  Metrics,
  TelemetryPanel,
  type TelemetryViewProps,
  useMetricsFormat,
  useTelemetry,
  withTelemetrySession,
} from './telemetry.js';
import { WorldClock } from './world-clock.js';

export const OpenworldOverview = withTelemetrySession(Overview);

function Overview(props: TelemetryViewProps) {
  const t = useT(),
    f = useMetricsFormat(),
    query = useTelemetry(props, 'status');
  return (
    <div className="ow-workspace">
      <TelemetryPanel title={t(key('overview'))} query={query}>
        {(status, observation) => (
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
            <WorldClock
              status={status}
              observedAt={observation.observedAt}
              live={observation.source === 'live' && props.runtimeState === 'running'}
            />
          </>
        )}
      </TelemetryPanel>
    </div>
  );
}
