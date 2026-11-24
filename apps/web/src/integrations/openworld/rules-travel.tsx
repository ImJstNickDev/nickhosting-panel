import { useState } from 'react';
import { useFormat } from '../../app/i18n.js';
import { SearchField } from '../../components/workspace-controls.js';
import type { OpenRuleForm } from './rules-action.js';
import { RuleIcon, type RuleSnapshot, SettingRow, useRuleText } from './rules-fields.js';

export function TravelRules({
  data,
  manage,
  edit,
}: {
  data: RuleSnapshot;
  manage: boolean;
  edit: OpenRuleForm;
}) {
  const r = useRuleText(),
    format = useFormat();
  const [filter, setFilter] = useState(''),
    [selected, setSelected] = useState<string | null>(null);
  const area = data.borders;
  if (!area) return <p className="ow-rule-empty">{r('unavailable')}</p>;
  const canEdit = !!(manage && data.capabilities.borders);
  const chooseTravel = (space: boolean, allowed: boolean, world = '') =>
    edit({
      title: r(space ? 'spaceTravel' : 'worldTravel'),
      subject: space ? undefined : world,
      fields: [
        {
          name: 'value',
          label: r('access'),
          kind: 'choice',
          initial: allowed ? 'open' : 'closed',
          options: [
            { value: 'open', label: r('open') },
            { value: 'closed', label: r('closed') },
          ],
        },
      ],
      action: (v) =>
        v.value === (allowed ? 'open' : 'closed')
          ? null
          : space
            ? { kind: 'spaceTravel', allowed: v.value === 'open' }
            : { kind: 'worldTravel', world, allowed: v.value === 'open' },
    });
  const worlds = area.worlds
    .filter((w) => w.world.toLocaleLowerCase().includes(filter.toLocaleLowerCase().trim()))
    .sort(
      (a, b) =>
        Number(b.description === 'closed' || (b.border && b.border.enabled !== false)) -
          Number(a.description === 'closed' || (a.border && a.border.enabled !== false)) ||
        a.world.localeCompare(b.world),
    );
  return (
    <section className="ow-rule-panel">
      <header className="ow-rule-heading">
        <h2>{r('travel')}</h2>
      </header>
      <SettingRow
        label={r('spaceTravel')}
        value={r(area.spaceOpen ? 'open' : 'closed')}
        edit={canEdit ? () => chooseTravel(true, area.spaceOpen) : undefined}
      />
      <div className="ow-rule-heading ow-rule-section-heading">
        <h3>{r('worlds')}</h3>
        {area.worlds.length > 5 && (
          <SearchField
            label={r('findWorld')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </div>
      {worlds.map((w) => {
        const b = w.border,
          enabled = b && b.enabled !== false,
          cur = selected === w.world;
        const allowed = w.description !== 'closed';
        const borderStatus = enabled
          ? r('radiusLabel', { radius: format.number(b.radiusMeters) })
          : r('noBorder');
        return (
          <div className="ow-travel-world" key={w.world}>
            <button
              type="button"
              className="ow-travel-toggle"
              aria-expanded={cur}
              onClick={() => setSelected(cur ? null : w.world)}
            >
              <span className="ow-world-name">
                <RuleIcon name="world" />
                {w.world}
              </span>
              <span>
                {r(allowed ? 'open' : 'closed')}
                {enabled ? ` · ${borderStatus}` : ''}
              </span>
              <RuleIcon name="arrow" size={14} />
            </button>
            {cur && (
              <div className="ow-travel-settings">
                <SettingRow
                  label={r('worldTravel')}
                  value={r(allowed ? 'open' : 'closed')}
                  edit={canEdit ? () => chooseTravel(false, allowed, w.world) : undefined}
                />
                <SettingRow
                  label={r('border')}
                  value={borderStatus}
                  edit={
                    canEdit && (enabled || !!b?.radiusMeters)
                      ? () =>
                          edit({
                            title: r('border'),
                            subject: w.world,
                            fields: [
                              {
                                name: 'value',
                                kind: 'choice',
                                label: r('border'),
                                initial: enabled ? 'on' : 'off',
                                options: [
                                  { value: 'on', label: r('enabled') },
                                  { value: 'off', label: r('disabled') },
                                ],
                              },
                            ],
                            action: (v) =>
                              v.value === (enabled ? 'on' : 'off')
                                ? null
                                : {
                                    kind: 'borderEnabled',
                                    world: w.world,
                                    enabled: v.value === 'on',
                                  },
                          })
                      : undefined
                  }
                />
                <SettingRow
                  label={r('centre')}
                  value={
                    b
                      ? r('coordinates', {
                          longitude: format.number(b.longitude, 5),
                          latitude: format.number(b.latitude, 5),
                        })
                      : '—'
                  }
                  edit={
                    canEdit
                      ? () =>
                          edit({
                            title: r('centre'),
                            subject: w.world,
                            fields: [
                              {
                                name: 'lon',
                                label: r('lon'),
                                kind: 'number',
                                min: -180,
                                max: 180,
                                step: 'any',
                                initial: String(b?.longitude ?? ''),
                              },
                              {
                                name: 'lat',
                                label: r('lat'),
                                kind: 'number',
                                min: -90,
                                max: 90,
                                step: 'any',
                                initial: String(b?.latitude ?? ''),
                              },
                            ],
                            action: (v) =>
                              !v.lon ||
                              !v.lat ||
                              (Number(v.lon) === b?.longitude && Number(v.lat) === b?.latitude)
                                ? null
                                : {
                                    kind: 'borderCenter',
                                    world: w.world,
                                    longitude: Number(v.lon),
                                    latitude: Number(v.lat),
                                  },
                          })
                      : undefined
                  }
                />
                <SettingRow
                  label={r('radius')}
                  value={b ? `${format.number(b.radiusMeters)} m` : '—'}
                  edit={
                    canEdit
                      ? () =>
                          edit({
                            title: r('radius'),
                            subject: w.world,
                            description: r('radiusEnables'),
                            fields: [
                              {
                                name: 'value',
                                label: r('radius'),
                                kind: 'number',
                                initial: String(b?.radiusMeters || ''),
                                min: 16,
                                step: 'any',
                              },
                            ],
                            action: (v) =>
                              !v.value || (Number(v.value) === b?.radiusMeters && enabled)
                                ? null
                                : { kind: 'borderRadius', world: w.world, value: Number(v.value) },
                          })
                      : undefined
                  }
                />
              </div>
            )}
          </div>
        );
      })}
      {!worlds.length && <p className="ow-rule-empty">{r(filter ? 'noMatches' : 'noBorders')}</p>}
    </section>
  );
}
