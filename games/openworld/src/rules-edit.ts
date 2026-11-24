import { DomainError } from '@nickhosting/core';
import {
  type OpenworldRuleAction,
  type OpenworldRuleRole,
  type OpenworldRulesSnapshot,
  type OpenworldRuleWorld,
  type OpenworldRuleZone,
  openworldZoneName,
} from './rules.js';
import type { OpenworldRuleCommand } from './rules-console.js';

type Edit = Exclude<OpenworldRuleAction, { kind: 'difficulty' | 'unban' }>;
type State = Partial<
  Pick<OpenworldRulesSnapshot, 'roles' | 'zones' | 'borders' | 'globalFlags' | 'naturalSpawning'>
>;
type Plan = { command: OpenworldRuleCommand; matches: (next: State) => boolean };
function checked<T>(state: T | null | undefined): T {
  if (state == null) throw new DomainError('integration_unavailable');
  return state;
}
function missing(): never {
  throw new DomainError('not_found');
}
function invalid(): never {
  throw new DomainError('validation_failed');
}

function zonePlan(action: Extract<Edit, { zoneId: number }>, state: State): Plan {
  const zones = checked(state.zones);
  const target = zones.find((z) => z.id === action.zoneId) ?? missing();
  const { name } = target;
  // Native zone commands use names, even when two worlds store zones with the same name.
  if (
    zones.filter((z) => z.id === action.zoneId).length !== 1 ||
    !openworldZoneName.safeParse(name).success ||
    zones.filter((z) => z.name.toLowerCase() === name.toLowerCase()).length !== 1
  )
    throw new DomainError('conflict');
  const edit = (command: OpenworldRuleCommand, check: (z: OpenworldRuleZone) => boolean): Plan => ({
    command,
    matches: (next) =>
      next.zones?.some((z) => z.id === target.id && z.world === target.world && check(z)) === true,
  });
  switch (action.kind) {
    case 'zoneFlag':
      return edit(
        `zone set ${name} ${action.flag} ${action.value}`,
        (z) =>
          z.flags !== undefined &&
          (z.flags.find((f) => f.key === action.flag)?.value ?? 'default') === action.value,
      );
    case 'zonePreset': {
      const expected =
        action.value === 'safe'
          ? { explosions: 'deny', pvp: 'deny', damage: 'deny', mobs: 'deny' }
          : { pvp: 'allow', damage: 'allow' };
      return edit(`zone preset ${name} ${action.value}`, (z) =>
        Object.entries(expected).every(
          ([key, value]) => z.flags?.find((f) => f.key === key)?.value === value,
        ),
      );
    }
    case 'zoneRadius':
      if (target.shape !== 'circle') return invalid();
      return edit(`zone radius ${name} ${action.value}`, (z) => z.radius === action.value);
    case 'zonePriority':
      return edit(`zone priority ${name} ${action.value}`, (z) => z.priority === action.value);
    case 'zoneColor':
      return edit(
        `zone color ${name} ${action.value}`,
        (z) => z.color?.toLowerCase() === action.value.toLowerCase(),
      );
    case 'zoneDescription':
      return edit(
        `zone desc ${name}${action.value ? ` ${action.value}` : ''}`,
        (z) => z.description === action.value,
      );
    case 'zoneRename':
      if (
        zones.some((z) => z.id !== target.id && z.name.toLowerCase() === action.value.toLowerCase())
      )
        throw new DomainError('conflict');
      return edit(`zone rename ${name} ${action.value}`, (z) => z.name === action.value);
    case 'zoneAltitude':
      return edit(`zone altitude ${name} ${action.value?.join(' ') ?? 'none'}`, (z) =>
        action.value
          ? z.altitude?.[0] === action.value[0] && z.altitude[1] === action.value[1]
          : z.altitude === null,
      );
    case 'zoneDelete':
      return {
        command: `zone delete ${name}`,
        matches: (next) =>
          next.zones != null &&
          !next.zones.some(
            (z) => z.id === target.id || z.name.toLowerCase() === name.toLowerCase(),
          ),
      };
  }
}
function rolePlan(action: Extract<Edit, { role: string }>, state: State): Plan {
  const roles = checked(state.roles);
  const { role } = action;
  const existing = roles.entries.find((r) => r.key === role);
  if (role === 'superadmin' && (action.kind === 'roleDefault' || action.kind === 'rolePriority'))
    return invalid();
  if (action.kind === 'roleCreate') {
    if (existing) throw new DomainError('conflict');
    if (action.parent && !roles.entries.some((r) => r.key === action.parent)) return missing();
  } else if (!existing) return missing();
  const edit = (command: OpenworldRuleCommand, check: (r: OpenworldRuleRole) => boolean): Plan => ({
    command,
    matches: (next) => next.roles?.entries.some((r) => r.key === role && check(r)) === true,
  });
  switch (action.kind) {
    case 'roleCreate':
      return edit(
        `role create ${role}${action.parent ? ` ${action.parent}` : ''}`,
        (r) => !action.parent || r.parent === action.parent,
      );
    case 'roleDefault':
      return {
        command: `role default ${role}`,
        matches: (next) => next.roles?.defaultRole === role,
      };
    case 'roleDelete':
      if (role === 'superadmin' || role === roles.defaultRole) return invalid();
      return {
        command: `role delete ${role}`,
        matches: (next) => !!next.roles && !next.roles.entries.some((r) => r.key === role),
      };
    case 'roleParent': {
      const visited = new Set([role]);
      let parent = action.value;
      while (parent) {
        if (visited.has(parent)) return invalid();
        visited.add(parent);
        const next = roles.entries.find((r) => r.key === parent) ?? missing();
        parent = next.parent;
      }
      return edit(
        `role parent ${role} ${action.value ?? 'none'}`,
        (r) => r.parent === action.value,
      );
    }
    case 'roleColor':
      return edit(
        `role color ${role} ${action.value}`,
        (r) => r.color?.toLowerCase() === action.value.toLowerCase(),
      );
    case 'roleName':
      return edit(`role name ${role} ${action.value}`, (r) => r.name === action.value);
    case 'rolePriority':
      return edit(`role priority ${role} ${action.value}`, (r) => r.priority === action.value);
    case 'roleHomes':
      return edit(`role homes ${role} ${action.value}`, (r) => r.maxHomes === action.value);
    case 'rolePermission': {
      const own = checked(checked(existing).permissions);
      const expected = action.add
        ? own.includes(action.permission)
          ? own
          : [...own, action.permission]
        : own.filter((p) => p !== action.permission);
      return edit(
        `role ${action.add ? 'add' : 'remove'} ${role} ${action.permission}`,
        (r) =>
          r.permissions?.length === expected.length &&
          expected.every((p, i) => r.permissions?.[i] === p),
      );
    }
  }
}
function worldPlan(action: Extract<Edit, { world: string }>, state: State): Plan {
  const world = action.world.toLowerCase();
  const find = (s: State) => s.borders?.worlds.find((w) => w.world.toLowerCase() === world);
  checked(state.borders);
  if (!find(state)) return missing();
  const edit = (
    command: OpenworldRuleCommand,
    check: (w: OpenworldRuleWorld) => boolean,
  ): Plan => ({
    command,
    matches: (next) => {
      const w = find(next);
      return !!w && check(w);
    },
  });
  switch (action.kind) {
    case 'worldTravel':
      return edit(
        `border world ${world} ${action.allowed ? 'allow' : 'deny'}`,
        (w) => (w.description !== 'closed') === action.allowed,
      );
    case 'borderEnabled':
      return edit(
        `border ${action.enabled ? 'on' : 'off'} ${world}`,
        (w) =>
          w.border?.enabled === action.enabled ||
          (w.border?.enabled === undefined &&
            w.description === (action.enabled ? 'bounded' : 'open')),
      );
    case 'borderRadius':
      return edit(
        `border radius ${action.value} ${world}`,
        (w) =>
          w.border?.radiusMeters === action.value &&
          (w.border.enabled ?? w.description === 'bounded'),
      );
    case 'borderCenter':
      return edit(
        `border center ${action.longitude} ${action.latitude} ${world}`,
        (w) =>
          !!w.border &&
          Math.abs(w.border.longitude - action.longitude) <= 0.000005 &&
          Math.abs(w.border.latitude - action.latitude) <= 0.000005,
      );
  }
}

export function planOpenworldEditorAction(action: Edit, state: State): Plan {
  if ('zoneId' in action) return zonePlan(action, state);
  if ('role' in action) return rolePlan(action, state);
  if ('world' in action) return worldPlan(action, state);
  switch (action.kind) {
    case 'globalFlag':
      checked(state.globalFlags);
      return {
        command: `zone global ${action.flag} ${action.value}`,
        matches: (next) =>
          next.globalFlags != null && (next.globalFlags[action.flag] ?? 'default') === action.value,
      };
    case 'spaceTravel':
      checked(state.borders);
      return {
        command: `border space ${action.allowed ? 'allow' : 'deny'}`,
        matches: (next) => next.borders?.spaceOpen === action.allowed,
      };
    case 'spawning':
      checked(state.naturalSpawning);
      return {
        command: action.enabled ? 'mobs on' : 'mobs off',
        matches: (next) => next.naturalSpawning === action.enabled,
      };
  }
}
