import { useState, useSyncExternalStore } from 'react';
import { useT } from '../../app/i18n.js';
import { HistoryChart } from './history.js';
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

const narrow = '(max-width: 640px)';
function watchWidth(changed: () => void) {
  const query = window.matchMedia(narrow);
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
}
const isNarrow = () => window.matchMedia(narrow).matches;

function DiagnosticTable({
  headers,
  rows,
  selectorLabel = 'world',
}: {
  headers: string[];
  rows: { id: string; label: string; optionLabel?: string; values: string[] }[];
  selectorLabel?: string;
}) {
  const t = useT();
  const compact = useSyncExternalStore(watchWidth, isNarrow, () => false);
  const [selected, select] = useState('');
  const active = rows.find((row) => row.id === selected) ?? rows[0];
  if (compact && active)
    return (
      <div className="ow-table-compact">
        {rows.length > 1 ? (
          <label className="ow-metric-select">
            {t(key(selectorLabel))}
            <select value={active.id} onChange={(event) => select(event.currentTarget.value)}>
              {rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.optionLabel ?? row.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <h4>{active.label}</h4>
        )}
        <Metrics items={headers.slice(1).map((h, i) => [t(key(h)), active.values[i]])} />
      </div>
    );
  return (
    <div className="ow-scroll">
      <table className="ow-table">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col">
                {t(key(h))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              {row.values.map((v, i) => (
                <td key={headers[i + 1]}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const OpenworldPerformance = withTelemetrySession(Performance);

function Performance(props: TelemetryViewProps) {
  const t = useT(),
    f = useMetricsFormat();
  const bytes = (v: unknown) => (numeric(v) ? f.bytes(v) : '—');
  const status = useTelemetry(props, 'status'),
    history = useTelemetry(props, 'history'),
    chunks = useTelemetry(props, 'chunks'),
    storage = useTelemetry(props, 'storage');
  return (
    <div className="ow-workspace">
      <TelemetryPanel title={t(key('performance'))} query={status}>
        {(s) => (
          <>
            <Metrics
              large
              items={[
                [t(key('tps')), f.metric(s.tps)],
                [t(key('tickMean')), f.metric(s.tickMs?.mean, 'ms', 2)],
                [t(key('tickP99')), f.metric(s.tickMs?.p99, 'ms', 2)],
                [t(key('budget')), f.metric(s.tickBudgetMs, 'ms')],
              ]}
            />
            <details className="ow-disclosure">
              <summary>{t(key('phases'))}</summary>
              <Metrics
                items={[
                  [t(key('tickMax')), f.metric(s.tickMs?.max, 'ms', 2)],
                  [t(key('gameTick')), f.metric(s.tick)],
                ]}
              />
              <Metrics
                items={Object.entries(s.phasesMs ?? {})
                  .filter(([, v]) => numeric(v))
                  .map(([name, v]) => [t(key(`phase.${name}`)), f.metric(v, 'ms', 3)])}
              />
              {!Object.values(s.phasesMs ?? {}).some(numeric) && (
                <p className="muted">{t(key('detailedMetricsUnavailable'))}</p>
              )}
            </details>
            <details className="ow-disclosure">
              <summary>{t(key('terrainCache'))}</summary>
              <Metrics
                items={[
                  [t(key('backlog')), f.metric(s.chunks?.genBacklog)],
                  [t(key('generationRate')), f.metric(s.chunks?.generatedPerS, '/s')],
                  [t(key('generationTime')), f.metric(s.chunks?.genMeanMs, 'ms', 2)],
                  [t(key('served')), f.metric(s.chunks?.servedPerS, '/s')],
                  [t(key('memHits')), f.metric(s.chunks?.memHits)],
                  [t(key('diskHits')), f.metric(s.chunks?.diskHits)],
                ]}
              />
            </details>
          </>
        )}
      </TelemetryPanel>
      <TelemetryPanel secondary title={t(key('history'))} query={history}>
        {(data) => <HistoryChart history={data} />}
      </TelemetryPanel>
      <TelemetryPanel secondary title={t(key('worlds'))} query={chunks}>
        {(data) => (
          <>
            {data.worlds.length ? (
              <DiagnosticTable
                headers={['world', 'liveChunks', 'generated', 'saved', 'dirty', 'simQueue']}
                rows={data.worlds.map((w) => ({
                  id: w.key,
                  label: w.name || w.key,
                  values: [w.live, w.generatedColumns, w.savedColumns, w.dirty, w.simPending].map(
                    (v) => f.metric(v),
                  ),
                }))}
              />
            ) : (
              <p className="ow-empty">{t(key('noWorlds'))}</p>
            )}
            {data.hot.length > 0 && (
              <details className="ow-disclosure">
                <summary>{t(key('hotChunks'))}</summary>
                <DiagnosticTable
                  selectorLabel="chunk"
                  headers={['world', 'face', 'coords', 'editsRate', 'writesRate', 'score']}
                  rows={data.hot.map((w) => ({
                    id: JSON.stringify([w.world, w.face, w.i, w.j]),
                    label: w.world,
                    optionLabel: `${w.world} · ${f.metric(w.face)} / ${f.metric(w.i)}, ${f.metric(w.j)}`,
                    values: [
                      f.metric(w.face),
                      [f.metric(w.i), f.metric(w.j)].join(', '),
                      f.metric(w.editsPerS, '/s'),
                      f.metric(w.simWritesPerS, '/s'),
                      f.metric(w.score),
                    ],
                  }))}
                />
              </details>
            )}
          </>
        )}
      </TelemetryPanel>
      <TelemetryPanel secondary title={t(key('storage'))} query={storage}>
        {(s) => (
          <>
            <Metrics
              items={[
                [t(key('storageTotal')), numeric(s.totalBytes) ? f.bytes(s.totalBytes) : '—'],
                [t(key('files')), f.metric(s.totalFiles)],
              ]}
            />
            {s.worlds.length > 0 && (
              <details className="ow-disclosure">
                <summary>{t(key('stored'))}</summary>
                <DiagnosticTable
                  headers={['world', 'generatedBytes', 'savedBytes', 'pendingFlush', 'dirty']}
                  rows={s.worlds.map((w) => ({
                    id: w.key,
                    label: w.name || w.key,
                    values: [
                      bytes(w.generatedBytes),
                      bytes(w.savedBytes),
                      f.metric(w.pendingFlush),
                      f.metric(w.dirtyLive),
                    ],
                  }))}
                />
              </details>
            )}
            {s.parts.length > 0 && (
              <details className="ow-disclosure">
                <summary>{t(key('storageParts'))}</summary>
                <dl className="ow-breakdown">
                  {s.parts.map((p) => {
                    const split = p.key.lastIndexOf('.');
                    const category = split === -1 ? p.key : p.key.slice(split + 1);
                    const world = split === -1 ? null : p.key.slice(0, split);
                    const name = s.worlds.find((w) => w.key === world)?.name || world;
                    const label = ['logs', 'state', 'other', 'map', 'regions', 'chunks'].includes(
                      category,
                    )
                      ? t(key(`part.${category}`))
                      : category;
                    return (
                      <div key={p.key}>
                        <dt>{name ? `${name} · ${label}` : label}</dt>
                        <dd>{bytes(p.bytes)}</dd>
                      </div>
                    );
                  })}
                </dl>
              </details>
            )}
          </>
        )}
      </TelemetryPanel>
    </div>
  );
}
