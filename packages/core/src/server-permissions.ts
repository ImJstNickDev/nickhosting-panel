import { DomainError } from './errors.js';
import type { ResourceRole } from './permissions.js';

/** Presentation groups are not grants; each operation has an independent key. */
export interface ServerPermissionDefinition {
  key: string;
  resource: string;
  kind: 'read' | 'write' | 'additional';
  legacy: 'read' | 'operate' | 'manage';
  labelKey?: string;
  resourceLabelKey?: string;
}
export type ServerPermissionKey = string;
const definition = (
  resource: string,
  action: string,
  legacy: ServerPermissionDefinition['legacy'],
): ServerPermissionDefinition => ({
  key: `${resource}.${action}`,
  resource,
  kind: action === 'read' || action === 'write' ? action : 'additional',
  legacy,
});
export const serverPermissionDefinitions: readonly ServerPermissionDefinition[] = [
  ...['console', 'files', 'backups', 'settings', 'network', 'schedules', 'activity'].map(
    (resource) => definition(resource, 'read', 'read'),
  ),
  definition('console', 'power', 'operate'),
  definition('console', 'command', 'manage'),
  ...['write', 'delete', 'sftp'].map((action) => definition('files', action, 'manage')),
  definition('backups', 'create', 'operate'),
  definition('backups', 'download', 'read'),
  ...['restore', 'delete'].map((action) => definition('backups', action, 'manage')),
  ...['read', 'write', 'delete'].map((action) => definition('subusers', action, 'manage')),
  ...['settings', 'network', 'schedules'].map((resource) =>
    definition(resource, 'write', 'manage'),
  ),
  ...['run', 'delete'].map((action) => definition('schedules', action, 'manage')),
];

/** Role expansion is explicit so introducing a new key never elevates legacy roles accidentally. */
export function legacyServerPermissionKeys(
  role: ResourceRole | undefined,
  definitions: readonly ServerPermissionDefinition[] = serverPermissionDefinitions,
): string[] {
  if (!role) return [];
  return definitions
    .filter(
      (definition) =>
        role === 'owner' ||
        (definition.resource !== 'subusers' &&
          (role === 'manager' ||
            definition.legacy === 'read' ||
            (role === 'operator' && definition.legacy === 'operate'))),
    )
    .map(({ key }) => key);
}

/** Reject unknown permissions and incoherent grants instead of silently expanding access. */
export function assertServerPermissionKeys(
  keys: readonly string[],
  definitions: readonly ServerPermissionDefinition[] = serverPermissionDefinitions,
): void {
  if (keys.length === 0 || keys.length > 256 || new Set(keys).size !== keys.length)
    throw new DomainError('validation_failed');
  const known = new Map(definitions.map((definition) => [definition.key, definition]));
  for (const key of keys) {
    const definition = known.get(key);
    if (!definition || !keys.includes(`${definition.resource}.read`))
      throw new DomainError('validation_failed');
  }
}
