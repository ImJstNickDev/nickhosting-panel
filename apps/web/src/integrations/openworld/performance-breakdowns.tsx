import { type ReactNode, useId, useState } from 'react';
import type { OpenworldTelemetryData } from '../../../../../games/openworld/src/telemetry.js';
import { useFormat, useT } from '../../app/i18n.js';
import { key, numeric } from './telemetry.js';
import './performance-breakdowns.css';

const neutral = '#b4bccb';
const phases = [
  ['net', '#3786f5'],
  ['chunks', '#eb6834'],
  ['players', '#1baf7a'],
  ['edits', neutral],
  ['sim', '#eda100'],
  ['snapshot', '#e87ba4'],
  ['projectiles', neutral],
  ['entities', '#008300'],
  ['chests', neutral],
  ['send', '#4a3aa7'],
] as const;

type Storage = OpenworldTelemetryData['storage'];
const diskColors = new Map([
  ['map', '#3786f5'],
  ['regions', '#eb6834'],
  ['chunks', '#1baf7a'],
  ['planets', '#4d94a1'],
  ['screenshots', '#b66285'],
  ['state', '#7963aa'],
  ['logs', '#b07828'],
  ['other', '#788697'],
]);
const worldCategories = new Set(['map', 'regions', 'chunks']);

function reading(value: unknown) {
  return numeric(value) && value >= 0 ? value : undefined;
}

function measuredSum(values: (number | undefined)[]) {
  const measured = values.filter((value) => value !== undefined);
  return measured.length ? reading(measured.reduce((total, value) => total + value, 0)) : undefined;
}

type Slice = {
  id: string;
  label: string;
  color: string;
  value: number | undefined;
  displayValue: string;
};

type NumberFormat = ReturnType<typeof useFormat>['number'];
function precise(value: number | undefined, unit: string, format: NumberFormat) {
  if (!numeric(value)) return '—';
  if (value > 0 && value < 0.01) return `<${format(0.01, 2)}\u00a0${unit}`;
  return `${format(value, 2)}\u00a0${unit}`;
}

function share(value: number | undefined, total: number | undefined) {
  return value !== undefined && total !== undefined && total > 0
    ? (value / total) * 100
    : undefined;
}

export function Composition({
  slices,
  total,
  summaryId,
  detail,
}: {
  slices: Slice[];
  total: number | undefined;
  summaryId?: string;
  detail?: (selected: string) => ReactNode;
}) {
  const format = useFormat();
  const detailId = useId();
  const [selected, select] = useState<string>();
  const [hovered, hover] = useState<string>();
  const [focused, focus] = useState<string>();
  const pinned = slices.find((item) => item.id === selected)?.id;
  const highlighted = hovered ?? focused ?? pinned;
  const items = slices.map((slice) => {
    const percent = share(slice.value, total);
    const displayPercent = precise(percent, '%', format.number);
    const active = pinned === slice.id;
    const description = `${slice.label} · ${slice.displayValue} · ${displayPercent}`;
    return {
      ...slice,
      percent,
      displayPercent,
      interaction: {
        'aria-label': description,
        'aria-describedby': summaryId,
        'aria-pressed': active,
        'aria-expanded': detail ? active : undefined,
        'aria-controls': detail && active ? detailId : undefined,
        'data-highlighted': highlighted === slice.id,
        onPointerEnter: () => hover(slice.id),
        onPointerLeave: () => hover(undefined),
        onFocus: () => {
          hover(undefined);
          focus(slice.id);
        },
        onBlur: () => focus(undefined),
        onClick: () => select((current) => (current === slice.id ? undefined : slice.id)),
      },
    };
  });
  return (
    <>
      <div className="ow-composition-bar">
        {items.map((item) =>
          item.percent !== undefined && item.percent > 0 ? (
            <button
              key={item.id}
              type="button"
              style={{ width: `${item.percent}%`, backgroundColor: item.color }}
              {...item.interaction}
            />
          ) : null,
        )}
      </div>
      <ul className="ow-composition-legend">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" {...item.interaction}>
              <i aria-hidden="true" style={{ backgroundColor: item.color }} />
              <span>{item.label}</span>
              <strong>{item.displayValue}</strong>
              <small>{item.displayPercent}</small>
            </button>
          </li>
        ))}
      </ul>
      {detail && pinned !== undefined && <div id={detailId}>{detail(pinned)}</div>}
    </>
  );
}

export function TickPhases({ status }: { status: OpenworldTelemetryData['status'] }) {
  const t = useT();
  const format = useFormat();
  const slices = phases.map(([id, color]) => {
    const value = reading(status.phasesMs?.[id]);
    return {
      id,
      label: t(key(`phase.${id}`)),
      color,
      value,
      displayValue: precise(value, 'ms', format.number),
    };
  });
  const total = measuredSum(slices.map((item) => item.value));
  const budget = reading(status.tickBudgetMs);
  const budgetShare = share(total, budget);
  return (
    <section className="ow-composition ow-tick-phases">
      <header>
        <h3>{t(key('phases'))}</h3>
        {total !== undefined && (
          <p>
            <b>{t(key('phaseMeasured'), { time: precise(total, 'ms', format.number) })}</b>
            {numeric(budgetShare) && (
              <>
                {' '}
                ·{' '}
                {t(key('phaseBudgetShare'), {
                  share: precise(budgetShare, '%', format.number),
                  budget: precise(budget, 'ms', format.number),
                })}
              </>
            )}
          </p>
        )}
      </header>
      {total !== undefined ? (
        <Composition slices={slices} total={total} />
      ) : (
        <p className="ow-empty">{t(key('detailedMetricsUnavailable'))}</p>
      )}
    </section>
  );
}

type StorageGroup = {
  id: string;
  parts: {
    key: string;
    worldKey?: string;
    world?: string;
    labels: string[];
    bytes: Measurement;
    files: Measurement;
  }[];
};

type Measurement = { value?: number; incomplete: boolean };

function summarize(values: (number | undefined)[]): Measurement {
  return { value: measuredSum(values), incomplete: values.includes(undefined) };
}

function amount(measurement: Measurement, format: (value: number) => string) {
  if (measurement.value === undefined) return '—';
  return `${measurement.incomplete ? '≥ ' : ''}${format(measurement.value)}`;
}

function groupStorage(storage: Storage) {
  const worlds = new Map(storage.worlds.map((world) => [world.key, world.name || world.key]));
  const groups = new Map<string, StorageGroup>();
  // One category can occur in several worlds. Keep the original part key for each world row.
  const partsByKey = new Map<string, Storage['parts']>();
  for (const part of storage.parts) {
    const entries = partsByKey.get(part.key);
    if (entries) entries.push(part);
    else partsByKey.set(part.key, [part]);
  }
  for (const [partKey, entries] of partsByKey) {
    const dot = partKey.lastIndexOf('.');
    const prefix = partKey.slice(0, dot);
    const suffix = partKey.slice(dot + 1);
    const worldPart = dot > 0 && suffix && (worlds.has(prefix) || worldCategories.has(suffix));
    const id = worldPart ? suffix : partKey;
    let group = groups.get(id);
    if (!group) {
      group = { id, parts: [] };
      groups.set(id, group);
    }
    group.parts.push({
      key: partKey,
      labels: [
        ...new Set(
          entries.map((entry) => entry.label?.trim()).filter((label): label is string => !!label),
        ),
      ],
      worldKey: worldPart ? prefix : undefined,
      world: worldPart ? (worlds.get(prefix) ?? prefix) : undefined,
      bytes: summarize(entries.map((part) => reading(part.bytes))),
      files: summarize(entries.map((part) => reading(part.files))),
    });
  }
  return groups;
}

function reportedCategoryLabel(group: StorageGroup) {
  const labels = new Set(group.parts.flatMap((part) => part.labels));
  const label = labels.values().next().value;
  if (labels.size !== 1 || !label) return group.id;
  const folded = label.toLowerCase();
  const namesWorld = group.parts.some((part) =>
    [part.worldKey, part.world].some((name) => name && folded.includes(name.toLowerCase())),
  );
  return namesWorld ? group.id : label;
}

export function DiskBreakdown({ storage }: { storage: Storage }) {
  const t = useT();
  const format = useFormat();
  const groups = groupStorage(storage);
  const slices = Array.from(groups.values(), (group) => {
    const value = measuredSum(group.parts.map((part) => part.bytes.value));
    const color = diskColors.get(group.id);
    const incomplete = group.parts.some((part) => part.bytes.incomplete);
    return {
      id: group.id,
      label: color ? t(key(`part.${group.id}`)) : reportedCategoryLabel(group),
      color: color ?? neutral,
      value,
      displayValue: amount({ value, incomplete }, format.bytes),
      incomplete,
    };
  });
  const total = measuredSum(slices.map((item) => item.value));
  const summaryId = useId();
  const summaryKey = slices.some((item) => item.incomplete)
    ? 'itemizedStoragePartial'
    : 'itemizedStorage';
  return (
    <section className="ow-composition ow-disk-breakdown">
      <header>
        <h4>{t(key('storageParts'))}</h4>
        {total !== undefined && (
          <p id={summaryId}>{t(key(summaryKey), { bytes: format.bytes(total) })}</p>
        )}
      </header>
      {slices.length ? (
        <Composition
          slices={slices}
          total={total}
          summaryId={total !== undefined ? summaryId : undefined}
          detail={(selection) => {
            const group = groups.get(selection);
            if (!group) return null;
            const category = slices.find((slice) => slice.id === selection)?.label;
            return (
              <table className="ow-table ow-disk-detail">
                <caption>{category}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t(key('world'))}</th>
                    <th scope="col">{t(key('partSize'))}</th>
                    <th scope="col">{t(key('files'))}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.parts.map((part) => (
                    <tr key={part.key}>
                      <th scope="row">
                        {part.world ?? t(key('serverWide'))}
                        {!diskColors.has(group.id) &&
                          part.labels
                            .filter((label) => label !== category && label !== part.world)
                            .map((label) => <small key={label}>{label}</small>)}
                      </th>
                      <td>{amount(part.bytes, format.bytes)}</td>
                      <td>{amount(part.files, format.number)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          }}
        />
      ) : (
        <p className="ow-empty">{t(key('noDiskParts'))}</p>
      )}
    </section>
  );
}
