import { dirname, resolve, sep } from 'node:path';
import { DomainError } from './errors.js';

type StorageEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Explicit host-runtime override. Containers omit it and keep /app/mountdata.
 * Host callers must first validate that the configured mount already exists.
 */
export function runtimeStorageRoot(env: StorageEnvironment = {}): string {
  const configured = env.NH_MOUNTDATA_ROOT;
  if (
    configured !== undefined &&
    (!configured || configured !== configured.trim() || /[\0\r\n]/.test(configured))
  )
    throw new DomainError('configuration_invalid');
  const root = resolve(configured ?? './mountdata');
  if (root === dirname(root) || root === process.cwd())
    throw new DomainError('configuration_invalid');
  return root;
}

/** Settings remain logical descendants, never arbitrary user-supplied host paths. */
export function resolveContentStoragePath(setting: string, env: StorageEnvironment = {}): string {
  if (!/^\.\/mountdata\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(setting))
    throw new DomainError('configuration_invalid');
  const root = runtimeStorageRoot(env);
  const target = resolve(root, setting.slice('./mountdata/'.length));
  if (!target.startsWith(`${root}${sep}`)) throw new DomainError('configuration_invalid');
  return target;
}
