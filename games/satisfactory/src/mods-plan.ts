import { compare, valid } from 'semver';
import type { SatisfactoryModLock, SatisfactoryModSelection } from './mods.js';

export type SatisfactoryModChange = {
  reference: string;
  action: 'install' | 'remove' | 'update' | 'enable' | 'disable';
  fromVersion: string | null;
  toVersion: string | null;
  dependency: boolean;
  requiredBy: string[];
};

/** Compare resolved graphs, not just selected roots. Disabled roots can remain
 * installed when another enabled root needs them; show that dependency honestly.
 */
export function diffSatisfactoryMods(input: {
  previousLock: SatisfactoryModLock;
  nextLock: SatisfactoryModLock;
  previousSelection: SatisfactoryModSelection;
  selection: SatisfactoryModSelection;
  vanilla?: boolean;
}): SatisfactoryModChange[] {
  const previous = new Map(input.previousSelection.map((mod) => [mod.reference, mod]));
  const selected = new Map(input.selection.map((mod) => [mod.reference, mod]));
  const nextMods = input.vanilla ? {} : input.nextLock.mods;
  const references = new Set([
    ...Object.keys(input.previousLock.mods),
    ...Object.keys(nextMods),
    ...previous.keys(),
    ...selected.keys(),
  ]);
  const changes: SatisfactoryModChange[] = [];
  for (const reference of [...references].sort()) {
    const before = input.previousLock.mods[reference];
    const after = nextMods[reference];
    const beforeRoot = previous.get(reference);
    const afterRoot = selected.get(reference);
    let action: SatisfactoryModChange['action'] | undefined;
    if (before && !after) action = afterRoot?.enabled === false ? 'disable' : 'remove';
    else if (!before && after)
      action = beforeRoot?.enabled === false && afterRoot?.enabled !== false ? 'enable' : 'install';
    else if (before && after && before.version !== after.version) action = 'update';
    else if (
      beforeRoot &&
      afterRoot &&
      (beforeRoot.enabled !== false) !== (afterRoot.enabled !== false)
    )
      action = afterRoot.enabled === false ? 'disable' : 'enable';
    else if (!beforeRoot && afterRoot?.enabled === false) action = 'disable';
    else if (beforeRoot?.enabled === false && !afterRoot && !after) action = 'remove';
    if (!action) continue;
    changes.push({
      reference,
      action,
      fromVersion: before?.version ?? beforeRoot?.version ?? null,
      toVersion: after?.version ?? (afterRoot?.enabled === false ? afterRoot.version : null),
      dependency: after ? !afterRoot || afterRoot.enabled === false : !beforeRoot,
      requiredBy: Object.entries(nextMods)
        .filter(([, mod]) => Object.hasOwn(mod.dependencies ?? {}, reference))
        .map(([parent]) => parent)
        .sort(),
    });
  }
  return changes;
}

export function compareSatisfactoryModVersions(left: string, right: string): number {
  if (!valid(left) || !valid(right)) return left.localeCompare(right);
  return compare(left, right);
}
