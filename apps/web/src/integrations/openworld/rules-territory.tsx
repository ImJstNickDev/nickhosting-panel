import { useId, useState } from 'react';
import { Link } from 'react-router';
import {
  type OpenworldRuleAction,
  type OpenworldRuleFlag,
  type OpenworldRuleValue,
  openworldDifficulties,
  openworldZoneName,
} from '../../../../../games/openworld/src/rules.js';
import { useFormat } from '../../app/i18n.js';
import { SearchField } from '../../components/workspace-controls.js';
import { zoneMapLink } from './map-players.js';
import type { FormField, OpenRuleForm } from './rules-action.js';
import {
  RuleIcon,
  type RuleSnapshot,
  type RuleText,
  SettingRow,
  tintStyle,
  useRuleText,
  type Zone,
} from './rules-fields.js';

const flags: OpenworldRuleFlag[] = [
  'build',
  'chests',
  'pvp',
  'pve',
  'mobs',
  'damage',
  'explosions',
  'entry',
];
const states: OpenworldRuleValue[] = ['allow', 'deny', 'default'];
type WorldProps = { data: RuleSnapshot; edit: OpenRuleForm; manage: boolean };
function flagValue(r: RuleText, value?: string, unknown = false) {
  return r(unknown ? 'unavailable' : (value ?? 'gameDefault'));
}
function uniqueZone(data: RuleSnapshot, zone: Zone) {
  return (
    !!zone.id &&
    openworldZoneName.safeParse(zone.name).success &&
    data.zones?.filter((z) => z.id === zone.id || z.name.toLowerCase() === zone.name.toLowerCase())
      .length === 1
  );
}
function RuleRows({ data, zone, edit, manage }: WorldProps & { zone?: Zone }) {
  const r = useRuleText();
  const editable =
    manage &&
    (zone ? data.capabilities.zones && uniqueZone(data, zone) : data.capabilities.globals);
  if (zone ? !zone.flags : data.globalFlags == null)
    return <p className="ow-rule-empty">{r('unavailable')}</p>;
  return (
    <div className="ow-flag-grid">
      {flags
        .filter((flag) => zone || flag !== 'entry')
        .map((flag) => {
          const base = flag === 'entry' ? undefined : data.globalFlags?.[flag];
          const local = zone?.flags?.find((f) => f.key === flag)?.value;
          const assigned = zone ? local : base;
          const inherited = Boolean(zone && !local);
          const value = flagValue(r, assigned ?? base, inherited && data.globalFlags == null);
          const title = r(`flag.${flag}`);
          const change = () =>
            edit({
              title,
              subject: zone?.name ?? r('gameplay'),
              description: r(`help.${flag}`),
              fields: [
                {
                  name: 'value',
                  label: r('ruleSetting'),
                  kind: 'choice',
                  initial: assigned ?? 'default',
                  options: states.map((v) => ({
                    value: v,
                    label: r(
                      v === 'default' ? (zone && flag !== 'entry' ? 'useWorld' : 'gameDefault') : v,
                    ),
                    ...(v === 'default' && zone && flag !== 'entry'
                      ? {
                          description: r('worldValue', {
                            value: flagValue(r, base, data.globalFlags == null),
                          }),
                        }
                      : {}),
                  })),
                },
              ],
              action: (v) =>
                v.value === (assigned ?? 'default')
                  ? null
                  : zone?.id
                    ? {
                        kind: 'zoneFlag',
                        zoneId: zone.id,
                        flag,
                        value: v.value as OpenworldRuleValue,
                      }
                    : flag === 'entry'
                      ? null
                      : { kind: 'globalFlag', flag, value: v.value as OpenworldRuleValue },
            });
          const val = (
            <>
              <span
                className="ow-state-symbol"
                data-tone={inherited ? 'default' : (assigned ?? 'default')}
              >
                <RuleIcon
                  size={13}
                  name={
                    inherited
                      ? 'inherit'
                      : assigned === 'deny'
                        ? 'minus'
                        : assigned === 'allow'
                          ? 'check'
                          : 'inherit'
                  }
                />
              </span>
              {value}
              {editable && <RuleIcon name="arrow" size={12} />}
            </>
          );
          return (
            <div key={flag} className="ow-flag-row">
              <div>
                <strong>{title}</strong>
                {zone && (
                  <small>
                    {flag === 'entry'
                      ? r('zoneOnly')
                      : inherited
                        ? r('inheritedWorld')
                        : r('worldValue', { value: flagValue(r, base, data.globalFlags == null) })}
                  </small>
                )}
              </div>
              {editable ? (
                <button
                  type="button"
                  className="ow-rule-value"
                  aria-label={`${title}: ${value}`}
                  onClick={change}
                >
                  {val}
                </button>
              ) : (
                <span className="ow-rule-value">{val}</span>
              )}
            </div>
          );
        })}
    </div>
  );
}

function zoneNotes(zone: Zone, global: RuleSnapshot['globalFlags'], r: RuleText) {
  const own = (zone.flags ?? []).filter((f) => flags.includes(f.key as OpenworldRuleFlag));
  const comparison = own.find(
    (f) => global?.[f.key as OpenworldRuleFlag] && global[f.key as OpenworldRuleFlag] !== f.value,
  );
  if (comparison) {
    const base = global?.[comparison.key as OpenworldRuleFlag];
    return r('zoneException', {
      flag: r(`flag.${comparison.key}`),
      local: r(comparison.value),
      base: r(base ?? 'gameDefault'),
    });
  }
  if (!own.length) return zone.flags ? r('inheritsWorld') : zone.description;
  return (
    own
      .slice(0, 2)
      .map((f) => r('flagSummary', { flag: r(`flag.${f.key}`), value: r(f.value) }))
      .join(' · ') + (own.length > 2 ? ` · +${own.length - 2}` : '')
  );
}

// A local outline, scaled to the tile; unwrap coordinates before fitting a polygon at the date line.
function ZoneMark({ zone }: { zone: Zone }) {
  const gridId = useId();
  let outline: string | undefined;
  if (zone.shape === 'polygon' && zone.points && zone.points.length >= 3) {
    const first = zone.points[0];
    if (first) {
      const latScale = Math.max(0.01, Math.cos((first[1] * Math.PI) / 180));
      const xy = zone.points.map(
        ([lon, lat]) => [(((lon - first[0] + 540) % 360) - 180) * latScale, lat] as const,
      );
      const xs = xy.map((p) => p[0]),
        ys = xy.map((p) => p[1]);
      const xmin = Math.min(...xs),
        xmax = Math.max(...xs),
        ymin = Math.min(...ys),
        ymax = Math.max(...ys);
      const span = Math.max(xmax - xmin, ymax - ymin);
      if (span > 0)
        outline = xy
          .map(
            ([x, y]) =>
              `${22 + ((x - (xmin + xmax) / 2) * 27) / span},${22 - ((y - (ymin + ymax) / 2) * 27) / span}`,
          )
          .join(' ');
    }
  }
  return (
    <span className="ow-zone-mark" style={tintStyle(zone.color)}>
      <svg aria-hidden="true" width="44" height="44" viewBox="0 0 44 44">
        <defs>
          <pattern id={gridId} width="8" height="8" patternUnits="userSpaceOnUse">
            <path
              d="M 8 0 H 0 V 8"
              fill="none"
              stroke="currentColor"
              strokeWidth=".65"
              opacity=".22"
            />
          </pattern>
        </defs>
        <rect width="44" height="44" fill={`url(#${gridId})`} />
        {zone.shape === 'circle' ? (
          <circle cx="22" cy="22" r="12.5" className="ow-zone-outline" />
        ) : outline ? (
          <polygon points={outline} className="ow-zone-outline" />
        ) : (
          <path d="m22 9 12 7v13l-12 7-12-7V16Z" className="ow-zone-outline" />
        )}
      </svg>
    </span>
  );
}
export function WorldRules({
  data,
  edit,
  manage,
  canDifficulty,
  selectZone,
  openTravel,
}: WorldProps & {
  canDifficulty: boolean;
  selectZone: (zone: Zone) => void;
  openTravel: () => void;
}) {
  const r = useRuleText();
  const [zoneSearch, setZoneSearch] = useState('');
  const [all, setAll] = useState(false);
  const zones = (data.zones ?? []).filter((z) =>
    `${z.name} ${z.world ?? ''}`
      .toLocaleLowerCase()
      .includes(zoneSearch.trim().toLocaleLowerCase()),
  );
  const exceptions =
    data.borders?.worlds.filter(
      (w) => w.description === 'closed' || (w.border && w.border.enabled !== false),
    ) ?? [];
  const changeDifficulty = () =>
    edit({
      title: r('changeDifficulty'),
      subject: r('gameplay'),
      fields: [
        {
          label: r('difficulty'),
          name: 'value',
          kind: 'select',
          initial: data.difficulty ?? '',
          options: openworldDifficulties.map((v) => ({ value: v, label: r(v) })),
        },
      ],
      action: (v) =>
        v.value === data.difficulty
          ? null
          : { kind: 'difficulty', value: v.value as NonNullable<RuleSnapshot['difficulty']> },
    });
  return (
    <>
      <section className="ow-rule-panel ow-rule-global">
        <header className="ow-rule-heading">
          <h2>{r('gameplay')}</h2>
          {canDifficulty && data.capabilities.difficulty ? (
            <button
              type="button"
              className="ow-difficulty"
              aria-label={r('changeDifficulty')}
              onClick={changeDifficulty}
            >
              <RuleIcon name="difficulty" />
              <span>{r('difficulty')}</span>
              <strong>{r(data.difficulty ?? 'unavailable')}</strong>
              <RuleIcon name="arrow" size={12} />
            </button>
          ) : (
            <span className="ow-difficulty">
              <RuleIcon name="difficulty" />
              {r('difficulty')} <strong>{r(data.difficulty ?? 'unavailable')}</strong>
            </span>
          )}
        </header>
        <RuleRows {...{ data, edit, manage }} />
      </section>
      <section className="ow-rule-panel">
        <header className="ow-rule-heading">
          <h2>{r('zones')}</h2>
          {(data.zones?.length ?? 0) > 4 && (
            <SearchField
              label={r('findZone')}
              value={zoneSearch}
              onChange={(e) => setZoneSearch(e.target.value)}
            />
          )}
        </header>
        {zones.length ? (
          <ul className="ow-zone-list">
            {zones.slice(0, all || zoneSearch ? zones.length : 4).map((z) => (
              <li key={JSON.stringify([z.world, z.id ?? z.name])}>
                <button type="button" className="ow-zone-entry" onClick={() => selectZone(z)}>
                  <ZoneMark zone={z} />
                  <span>
                    <strong>{z.name}</strong>
                    {z.world && <span className="ow-zone-world">{z.world}</span>}
                    <small>{zoneNotes(z, data.globalFlags, r)}</small>
                  </span>
                  <RuleIcon name="arrow" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ow-rule-empty">
            {r(data.zones === null ? 'unavailable' : zoneSearch ? 'noMatches' : 'noZones')}
          </p>
        )}
        {!all && !zoneSearch && zones.length > 4 && (
          <button className="ow-rule-text" type="button" onClick={() => setAll(true)}>
            {r('allZones', { count: zones.length })}
          </button>
        )}
      </section>
      <section className="ow-rule-panel ow-travel-overview">
        <span className="ow-territory-marker">
          <RuleIcon name="travel" size={21} />
        </span>
        <div>
          <h2>{r('travel')}</h2>
          <p>
            {data.borders
              ? [
                  ...(data.borders.spaceOpen ? [] : [r('spaceClosed')]),
                  exceptions.length
                    ? r('restrictedWorlds', {
                        count: exceptions.length,
                        total: data.borders.worlds.length,
                      })
                    : r('allOpen', { count: data.borders.worlds.length }),
                ].join(' · ')
              : r('unavailable')}
          </p>
        </div>
        {data.borders && (
          <button className="ow-rule-text" type="button" onClick={openTravel}>
            {r('viewTravel')} <RuleIcon name="arrow" size={13} />
          </button>
        )}
      </section>
    </>
  );
}
export function ZoneDetail({
  data,
  zone,
  edit,
  manage,
  serverId,
  canMap,
}: WorldProps & { zone: Zone; serverId: string; canMap: boolean }) {
  const r = useRuleText(),
    format = useFormat();
  const [settings, setSettings] = useState(false);
  const canEdit = !!(manage && data.capabilities.zones && uniqueZone(data, zone));
  function single(field: FormField, make: (val: string) => OpenworldRuleAction) {
    edit({
      title: field.label,
      subject: zone.name,
      fields: [{ ...field, name: 'value' }],
      action: (v) => (v.value === (field.initial ?? '') ? null : make(v.value ?? '')),
    });
  }
  const zoneId = zone.id ?? 0;
  const alt = zone.altitude;
  const mapPoint = zone.centre ?? zone.points?.[0];
  return (
    <section className="ow-rule-panel">
      <header className="ow-rule-heading">
        <div className="ow-entity-name">
          <ZoneMark zone={zone} />
          <div>
            <h2>{zone.name}</h2>
            <small>{[zone.world, r(zone.shape ?? 'zone')].filter(Boolean).join(' · ')}</small>
          </div>
        </div>
        {canMap && zone.world && mapPoint && (
          <Link className="ow-rule-text" to={zoneMapLink(serverId, zone.world, ...mapPoint)}>
            {r('openMap')} <RuleIcon name="external" size={13} />
          </Link>
        )}
      </header>
      {zone.description && <p className="ow-zone-description">{zone.description}</p>}
      <div className="ow-subnav">
        <button type="button" aria-pressed={!settings} onClick={() => setSettings(false)}>
          {r('zoneRules')}
        </button>
        <button type="button" aria-pressed={settings} onClick={() => setSettings(true)}>
          {r('zoneDetails')}
        </button>
      </div>
      {settings ? (
        <div>
          {zone.centre && (
            <SettingRow
              label={r('centre')}
              value={r('coordinates', {
                longitude: format.number(zone.centre[0], 5),
                latitude: format.number(zone.centre[1], 5),
              })}
            />
          )}
          {zone.points?.length ? (
            <details className="ow-zone-points">
              <summary>{r('vertices', { count: zone.points.length })}</summary>
              <ol>
                {zone.points.map(([lon, lat], i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: A polygon may repeat a coordinate; the fixed vertex position identifies each entry.
                  <li key={`${i}-${lon}-${lat}`}>
                    {r('coordinates', {
                      longitude: format.number(lon, 5),
                      latitude: format.number(lat, 5),
                    })}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          <SettingRow
            label={r('zoneName')}
            value={zone.name}
            edit={
              canEdit
                ? () =>
                    single(
                      { label: r('zoneName'), name: 'value', initial: zone.name, maxLength: 64 },
                      (value) => ({ kind: 'zoneRename', zoneId, value }),
                    )
                : undefined
            }
          />
          <SettingRow
            label={r('description')}
            value={zone.description || '—'}
            edit={
              canEdit
                ? () =>
                    single(
                      {
                        label: r('description'),
                        name: 'value',
                        initial: zone.description,
                        maxLength: 200,
                        optional: true,
                      },
                      (value) => ({ kind: 'zoneDescription', zoneId, value }),
                    )
                : undefined
            }
          />
          <SettingRow
            label={r('colour')}
            value={
              <span className="ow-role-colour" style={tintStyle(zone.color)}>
                {zone.color ?? '—'}
              </span>
            }
            edit={
              canEdit
                ? () =>
                    single(
                      {
                        label: r('colour'),
                        name: 'value',
                        kind: 'color',
                        initial: zone.color ?? '#396554',
                      },
                      (value) => ({ kind: 'zoneColor', zoneId, value }),
                    )
                : undefined
            }
          />
          <SettingRow
            label={r('rank')}
            value={zone.priority ?? '—'}
            hint={r('zonePriorityHelp')}
            edit={
              canEdit
                ? () =>
                    single(
                      {
                        name: 'value',
                        label: r('rank'),
                        kind: 'number',
                        initial: String(zone.priority ?? 0),
                        min: -1000,
                        max: 1000,
                        step: 1,
                      },
                      (v) => ({ kind: 'zonePriority', zoneId, value: Number(v) }),
                    )
                : undefined
            }
          />
          {zone.shape === 'circle' && (
            <SettingRow
              label={r('radius')}
              value={zone.radius !== undefined ? `${format.number(zone.radius)} m` : '—'}
              edit={
                canEdit
                  ? () =>
                      single(
                        {
                          name: 'value',
                          label: r('radius'),
                          kind: 'number',
                          initial: String(zone.radius ?? ''),
                          min: 1,
                          max: 100000,
                          step: 'any',
                        },
                        (v) => ({ kind: 'zoneRadius', zoneId, value: Number(v) }),
                      )
                  : undefined
              }
            />
          )}
          <SettingRow
            label={r('altitude')}
            value={
              alt
                ? `${format.number(alt[0])} – ${format.number(alt[1])} m`
                : r(zone.altitude === undefined ? 'unavailable' : 'allAltitudes')
            }
            edit={
              canEdit
                ? () =>
                    edit({
                      title: r('altitude'),
                      subject: zone.name,
                      description: r('altitudeHint'),
                      fields: [
                        {
                          name: 'min',
                          kind: 'number',
                          step: 'any',
                          label: r('minAlt'),
                          optional: true,
                          initial: String(alt?.[0] ?? ''),
                        },
                        {
                          name: 'max',
                          kind: 'number',
                          step: 'any',
                          label: r('maxAlt'),
                          optional: true,
                          initial: String(alt?.[1] ?? ''),
                        },
                      ],
                      action: (v) => {
                        if (v.min === '' && v.max === '')
                          return alt ? { kind: 'zoneAltitude', zoneId, value: null } : null;
                        if (
                          !v.min ||
                          !v.max ||
                          (Number(v.min) === alt?.[0] && Number(v.max) === alt[1])
                        )
                          return null;
                        return {
                          kind: 'zoneAltitude',
                          zoneId,
                          value: [Number(v.min), Number(v.max)],
                        };
                      },
                    })
                : undefined
            }
          />
          {zone.memberCount !== undefined && (
            <SettingRow
              label={r('members')}
              value={format.number(zone.memberCount)}
              hint={r('zoneMembersHelp')}
            />
          )}
          {canEdit && (
            <button
              type="button"
              className="ow-rule-danger"
              onClick={() =>
                edit({
                  title: r('deleteZone'),
                  subject: zone.name,
                  description: r('deleteZoneHelp'),
                  confirm: r('deleteZone'),
                  destructive: true,
                  action: () => ({ kind: 'zoneDelete', zoneId }),
                })
              }
            >
              <RuleIcon name="trash" />
              {r('deleteZone')}
            </button>
          )}
        </div>
      ) : (
        <>
          <RuleRows {...{ data, zone, manage, edit }} />
          {canEdit && (
            <div className="ow-rule-footer">
              <button
                type="button"
                className="ow-rule-text"
                onClick={() =>
                  edit({
                    title: r('applyPreset'),
                    subject: zone.name,
                    fields: [
                      {
                        name: 'value',
                        label: r('preset'),
                        kind: 'choice',
                        options: [
                          { value: 'safe', label: r('safe'), description: r('safeHelp') },
                          { value: 'war', label: r('war'), description: r('warHelp') },
                        ],
                      },
                    ],
                    action: (v) =>
                      v.value === 'war' || v.value === 'safe'
                        ? { kind: 'zonePreset', zoneId, value: v.value }
                        : null,
                  })
                }
              >
                {r('applyPreset')} <RuleIcon name="arrow" size={13} />
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
