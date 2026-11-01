import { useEffect, useReducer } from 'react';
import type { getPlatformQuota } from '../../../../packages/server-management/src/platform-queries.js';
import type { Result } from '../api/contracts.js';

type StorageUsage = Result<typeof getPlatformQuota>['storageUsage'];

/** Expiry is internal metadata: the display never adds a timestamp or stale badge. */
export function useStorageUsage(
  usage: StorageUsage | undefined,
  serverTime: string | undefined,
  receivedAt: number,
): number | null {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const expiresAt = usage?.expiresAt;
  // Anchor the remaining server-side lifetime to query receipt so browser clock
  // skew does not make a recent sample instantly expire (or last for hours).
  const deadline =
    expiresAt && serverTime
      ? receivedAt + Math.max(0, Math.min(30_000, Date.parse(expiresAt) - Date.parse(serverTime)))
      : Number.NaN;
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      refresh();
      const remaining = deadline - Date.now();
      if (remaining > 0) timer = window.setTimeout(update, remaining);
    };
    update();
    // Background tabs can defer timers; recheck as soon as the page becomes active.
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [deadline]);
  if (!usage || usage.bytes === null) return null;
  // Only an empty inventory has a non-expiring zero.
  if (expiresAt === null) return usage.bytes === 0 ? 0 : null;
  return Number.isFinite(deadline) && Date.now() < deadline ? usage.bytes : null;
}
