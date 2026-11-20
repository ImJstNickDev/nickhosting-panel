import { queryOptions } from '@tanstack/react-query';
import type { getPlatformQuota } from '../../../../packages/server-management/src/platform-queries.js';
import { readApi } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { type WebSession, webSessionScope } from '../app/session.js';

export function platformQuotaQuery(session: WebSession | undefined) {
  return queryOptions({
    queryKey: ['quota', ...webSessionScope(session)],
    enabled: Boolean(session),
    networkMode: 'always',
    queryFn: async ({ signal }) => {
      // Anchor freshness before I/O so a delayed response cannot extend the display lease.
      const requestedAt = Date.now();
      const quota = await readApi<Result<typeof getPlatformQuota>>('/v1/platform/quotas', signal);
      return { ...quota, requestedAt };
    },
  });
}
