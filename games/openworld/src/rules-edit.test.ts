import { expect, it } from 'vitest';
import type { OpenworldRuleRole, OpenworldRuleZone } from './rules.js';
import { planOpenworldEditorAction } from './rules-edit.js';
import { globalFlags } from './rules-snapshot.js';

const zone: OpenworldRuleZone = {
  id: 2,
  name: 'Haven',
  world: 'earth',
  description: '',
  shape: 'circle',
  flags: [{ key: 'pvp', value: 'deny' }],
};
const role: OpenworldRuleRole = {
  key: 'visitor',
  name: 'Visitor',
  priority: 5,
  parent: 'player',
  permissions: ['home.*', '-home.use'],
};
const parent: OpenworldRuleRole = {
  key: 'player',
  name: 'Player',
  priority: 0,
  parent: null,
  permissions: ['chat'],
};

it('checks local overrides independently of identical settings inherited from the world', () => {
  const plan = planOpenworldEditorAction(
    { kind: 'zoneFlag', zoneId: 2, flag: 'pvp', value: 'default' },
    { zones: [zone] },
  );
  expect(plan.command).toBe('zone set Haven pvp default');
  expect(plan.matches({ globalFlags: { pvp: 'deny' }, zones: [zone] })).toBe(false);
  expect(plan.matches({ globalFlags: { pvp: 'deny' }, zones: [{ ...zone, flags: [] }] })).toBe(
    true,
  );
  expect(plan.matches({ zones: [{ ...zone, flags: undefined }] })).toBe(false);
});
it('refuses ambiguous zone names, unsafe file operands and invalid operations for the shape', () => {
  const rename = { kind: 'zoneRename', zoneId: 2, value: 'Quay' } as const;
  for (const other of [
    { ...zone, id: 5, name: 'haven', world: 'moon' },
    { ...zone, id: 4, name: 'Quay' },
  ]) {
    expect(() => planOpenworldEditorAction(rename, { zones: [zone, other] })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
  }
  expect(() =>
    planOpenworldEditorAction(rename, { zones: [{ ...zone, name: 'Haven\nstop' }] }),
  ).toThrow();
  expect(() =>
    planOpenworldEditorAction(
      { kind: 'zoneRadius', zoneId: 2, value: 27 },
      { zones: [{ ...zone, shape: 'polygon' }] },
    ),
  ).toThrow();
});
it('preserves the exact permission order when adding or removing a node and prevents cycles', () => {
  const roles = { defaultRole: 'player', entries: [parent, role] };
  const plan = planOpenworldEditorAction(
    { kind: 'rolePermission', role: 'visitor', permission: 'chest.use', add: true },
    { roles },
  );
  expect(plan.matches({ roles })).toBe(false);
  expect(
    plan.matches({
      roles: {
        ...roles,
        entries: [parent, { ...role, permissions: ['home.*', '-home.use', 'chest.use'] }],
      },
    }),
  ).toBe(true);
  expect(
    plan.matches({
      roles: {
        ...roles,
        entries: [parent, { ...role, permissions: ['-home.use', 'home.*', 'chest.use'] }],
      },
    }),
  ).toBe(false);
  expect(() =>
    planOpenworldEditorAction({ kind: 'roleParent', role: 'player', value: 'visitor' }, { roles }),
  ).toThrow();
});
it('confirms an observed empty override list but treats unknown console summaries as unavailable', () => {
  const snapshot = (header: string) => globalFlags({ accepted: true, lines: [header] });
  expect(snapshot('No zone yet (/zone create NAME [RADIUS]). Server rules: -')).toEqual({});
  expect(snapshot('2 zone(s). Server rules: pvp ✓, mobs ✗')).toEqual({
    pvp: 'allow',
    mobs: 'deny',
  });
  expect(snapshot('2 zone(s). Server rules: newRule ✗')).toBeNull();
});
