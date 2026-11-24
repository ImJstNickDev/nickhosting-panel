import { type ReactNode, useId, useMemo } from 'react';
import type { OpenworldFactoriesSnapshot } from '../../../../../games/openworld/src/factories.js';
import { factoryDeviceMessages } from '../../../../../games/openworld/src/ui/factory-device-catalog.js';
import { useT } from '../../app/i18n.js';
import { HistoryChart, type HistoryMetrics } from './history.js';
import { Composition } from './performance-breakdowns.js';
import { Metrics, numeric, useMetricsFormat } from './telemetry.js';

export const factoryKey = (name: string) => `games.openworld.factories.${name}`;

export function FactoryPanel({ title, children }: { title: string; children: ReactNode }) {
  const t = useT();
  const heading = useId();
  return (
    <section className="ow-panel" aria-labelledby={heading}>
      <header className="ow-heading">
        <h3 id={heading}>{t(factoryKey(title))}</h3>
      </header>
      {children}
    </section>
  );
}

const historyMetrics = {
  frequency: { unit: 'Hz', fields: [['hz', 'frequency']] },
  stepDuration: { unit: 'ms', fields: [['stepMs', 'meanStep']] },
  nodes: { unit: '', fields: [['nodes', 'nodes']] },
  cpuTime: { unit: 'ms', fields: [['cpuMs', 'cpuTime']] },
} as const satisfies HistoryMetrics;

export function FactoryHistory({
  rows,
  isLive,
  targetHz,
}: {
  targetHz: OpenworldFactoriesSnapshot['targetHz'];
  isLive: boolean;
  rows: NonNullable<OpenworldFactoriesSnapshot['history']>;
}) {
  const t = useT();
  const budgetMs = numeric(targetHz) && targetHz > 0 ? 1000 / targetHz : null;
  const guides =
    numeric(targetHz) && targetHz > 0 && numeric(budgetMs)
      ? {
          frequency: { label: t(factoryKey('currentTarget')), value: targetHz },
          stepDuration: {
            label: t(factoryKey('currentBudget')),
            value: budgetMs,
            aboveScaleLabel: t(factoryKey('aboveScale')),
          },
        }
      : undefined;
  const history = useMemo(() => {
    const timed = rows.map((row) => ({ row, stamp: row.t > 1e11 ? row.t : row.t * 1000 }));
    const cutoff = Math.max(...timed.map((point) => point.stamp)) - 600_000;
    const window = timed.filter((point) => point.stamp >= cutoff);
    return {
      t: window.map((point) => point.stamp),
      hz: window.map(({ row }) => row.hz ?? null),
      stepMs: window.map(({ row }) => row.stepMs ?? null),
      nodes: window.map(({ row }) => row.nodes ?? null),
      cpuMs: window.map(({ row }) => row.cpuMs ?? null),
    };
  }, [rows]);
  return (
    <FactoryPanel title="history">
      {rows.length ? (
        <HistoryChart
          history={history}
          groups={historyMetrics}
          guides={guides}
          firstMetric="frequency"
          metricKey={factoryKey}
          isLive={isLive}
        />
      ) : (
        <p className="ow-empty">{t(factoryKey('noSamples'))}</p>
      )}
    </FactoryPanel>
  );
}

const mediumColors = {
  item: '#c76b37',
  fluid: '#377bb1',
  electric: '#b28c29',
  signal: '#8267a5',
  rotation: '#33846c',
};
const phaseColors = {
  commands: '#879398',
  topology: '#526b8c',
  signals: mediumColors.signal,
  rotation: mediumColors.rotation,
  electric: mediumColors.electric,
  fluids: mediumColors.fluid,
  items: mediumColors.item,
  radio: '#a65c82',
  events: '#78848a',
};

export function FactoryPhases({
  phases,
  targetHz,
}: {
  phases: NonNullable<OpenworldFactoriesSnapshot['phasesMs']>;
  targetHz: OpenworldFactoriesSnapshot['targetHz'];
}) {
  const t = useT();
  const { metric } = useMetricsFormat();
  const slices = (Object.keys(phaseColors) as (keyof typeof phaseColors)[]).map((id) => {
    const value = phases[id] ?? undefined;
    return {
      id,
      label: t(factoryKey(`phase.${id}`)),
      color: phaseColors[id],
      value,
      displayValue: metric(value, 'ms', 5),
    };
  });
  const measured = slices.flatMap((slice) => slice.value ?? []);
  const total = measured.reduce((sum, value) => sum + value, 0);
  const budget = numeric(targetHz) && targetHz > 0 ? 1000 / targetHz : null;
  return (
    <FactoryPanel title="phases">
      {measured.length ? (
        <>
          <p className="ow-factory-caption">
            {t(factoryKey('phaseTime'), { duration: metric(total, 'ms', 5) })}
            {budget !== null && (
              <>
                {' '}
                ·{' '}
                {t(factoryKey('budgetShare'), {
                  percent: metric((100 * total) / budget, '%', 2),
                  budget: metric(budget, 'ms', 2),
                })}
              </>
            )}
          </p>
          <Composition slices={slices} total={total} />
        </>
      ) : (
        <p className="ow-empty">{t(factoryKey('noPhases'))}</p>
      )}
    </FactoryPanel>
  );
}

export function FactoryNetworks({
  counts,
}: {
  counts: NonNullable<OpenworldFactoriesSnapshot['counts']>;
}) {
  const t = useT();
  const { metric } = useMetricsFormat();
  const byMedium = counts.byMedium;
  const slices = Object.entries(byMedium ?? {})
    .map(([id, value]) => {
      const known = Object.hasOwn(mediumColors, id);
      return {
        id,
        value,
        color: known ? mediumColors[id as keyof typeof mediumColors] : '#7e898e',
        label: known ? t(factoryKey(`medium.${id}`)) : identifierLabel(id),
        displayValue: metric(value),
      };
    })
    .sort((a, b) => b.value - a.value);
  const classified = slices.reduce((sum, slice) => sum + slice.value, 0);
  const total = Math.max(counts.nets ?? 0, classified);
  const empty = counts.nets === 0 && classified === 0;
  return (
    <FactoryPanel title="networks">
      {slices.length && !empty ? (
        <Composition
          slices={slices}
          total={total}
          detail={(id) => {
            const slice = slices.find((slice) => slice.id === id);
            if (!slice) return null;
            return (
              <p className="ow-factory-selection">
                <strong>{slice.label}</strong> ·{' '}
                {t(factoryKey('networkCount'), { count: slice.displayValue })}
                {Object.hasOwn(mediumColors, id) && (
                  <span>{t(factoryKey(`mediumNote.${id}`))}</span>
                )}
              </p>
            );
          }}
        />
      ) : (
        <p className="ow-empty">{t(factoryKey(empty ? 'noNetworks' : 'noNetworkBreakdown'))}</p>
      )}
      <dl className="ow-factory-faults">
        {(['frozen', 'tooLong', 'tripped'] as const).map((id) => (
          <div key={id} data-alert={(counts[id] ?? 0) > 0}>
            <dt>{t(factoryKey(id))}</dt>
            <dd>{metric(counts[id])}</dd>
          </div>
        ))}
      </dl>
    </FactoryPanel>
  );
}

function identifierLabel(id: string) {
  return id.replaceAll('_', ' ');
}

export function FactoryQuantities({
  rows,
  empty,
}: {
  rows: { id: string; label: string; value?: number | null }[];
  empty: string;
}) {
  const t = useT();
  const { metric } = useMetricsFormat();
  if (!rows.length) return <p className="ow-empty">{t(factoryKey(empty))}</p>;
  const sorted = [...rows].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const largest = sorted[0]?.value ?? 0;
  return (
    <dl className="ow-factory-quantities">
      {sorted.map(({ id, label, value }) => (
        <div key={id}>
          <dt>{label}</dt>
          <dd>
            <span className="ow-factory-track" aria-hidden="true">
              <i
                style={{ width: `${largest > 0 && numeric(value) ? (100 * value) / largest : 0}%` }}
              />
            </span>
            <strong>{metric(value)}</strong>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function FactoryDevices({
  counts,
}: {
  counts: NonNullable<OpenworldFactoriesSnapshot['counts']>;
}) {
  const t = useT();
  const rows = Object.entries(counts.byDevice ?? {}).map(([id, value]) => ({
    id,
    label: Object.hasOwn(factoryDeviceMessages, `device.${id}`)
      ? t(factoryKey(`device.${id}`))
      : identifierLabel(id),
    value,
  }));
  const active = rows.filter((row) => row.value !== 0);
  const inactive = rows.filter((row) => row.value === 0);
  return (
    <FactoryPanel title="devices">
      {(active.length > 0 || counts.nodes === 0 || !inactive.length) && (
        <FactoryQuantities
          rows={active}
          empty={counts.nodes === 0 ? 'noDevices' : 'noDeviceBreakdown'}
        />
      )}
      {inactive.length > 0 && (
        <details className="ow-disclosure">
          <summary>{t(factoryKey('inactiveDevices'), { count: inactive.length })}</summary>
          <FactoryQuantities rows={inactive} empty="noDevices" />
        </details>
      )}
    </FactoryPanel>
  );
}

export function FactoryMemory({
  memory,
}: {
  memory: NonNullable<OpenworldFactoriesSnapshot['memory']>;
}) {
  const t = useT();
  const { bytes } = useMetricsFormat();
  const amount = (value: unknown) => (numeric(value) ? bytes(value) : '—');
  return (
    <details className="ow-panel ow-factory-memory">
      <summary>
        {t(factoryKey('memory'))}
        <strong>{amount(memory.totalBytes)}</strong>
      </summary>
      <Metrics
        items={(
          ['nodes', 'links', 'transit', 'systems', 'index', 'topology', 'other'] as const
        ).map((id) => [t(factoryKey(`memory.${id}`)), amount(memory[id])])}
      />
    </details>
  );
}
