import { useEffect, useReducer } from 'react';
import type { getPlatformQuota } from '../../../../packages/server-management/src/platform-queries.js';
import type { Result } from '../api/contracts.js';

type StorageUsage = Result<typeof getPlatformQuota>['storageUsage'];

/** Use the server's remaining lifetime and a local clock anchor to tolerate clock skew. */
export function storageDisplayDeadline(
  expiresAt: string | null | undefined,
  serverTime: string | undefined,
  anchor: number,
): number {
  if (!expiresAt || !serverTime) return Number.NaN;
  return anchor + Math.max(0, Math.min(30_000, Date.parse(expiresAt) - Date.parse(serverTime)));
}

export function useRefreshAtExpiry(deadline: number, now = Date.now) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      const remaining = deadline - now();
      if (remaining > 0) timer = window.setTimeout(update, Math.min(remaining, 2_147_483_647));
      else refresh();
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
  }, [deadline, now]);
}

/** Expiry is internal metadata: the display never adds a timestamp or stale badge. */
export function useStorageUsage(
  usage: StorageUsage | undefined,
  serverTime: string | undefined,
  receivedAt: number,
): number | null {
  const expiresAt = usage?.expiresAt;
  const deadline = storageDisplayDeadline(expiresAt, serverTime, receivedAt);
  useRefreshAtExpiry(deadline);
  if (!usage || usage.bytes === null) return null;
  // Only an empty inventory has a non-expiring zero.
  if (expiresAt === null) return usage.bytes === 0 ? 0 : null;
  return Number.isFinite(deadline) && Date.now() < deadline ? usage.bytes : null;
}
