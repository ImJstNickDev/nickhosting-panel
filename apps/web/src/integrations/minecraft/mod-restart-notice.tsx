import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { api, apiError } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { useSession } from '../../app/session.js';
import { serverPath } from '../../features/service-contracts.js';
import './mod-restart-notice.css';

const restartSchema = z.object({
  required: z.boolean(),
  changedAt: z.iso.datetime().optional(),
});

/** The receipt describes published files, not whether arbitrary mod code loaded.
 * A console connection or a "running" message alone never clears it. */
export function MinecraftModRestartNotice({
  serverId,
  kind = 'mods',
  state,
  revision,
}: {
  serverId: string;
  kind?: 'mods' | 'plugins';
  state?: string;
  revision?: string;
}) {
  const t = useT();
  const session = useSession();
  const context = session.data?.context;
  const identity =
    context && !session.error
      ? [
          context.actorUserId,
          context.subjectUserId,
          context.sessionType,
          context.support?.id ?? '',
        ].join(':')
      : undefined;
  const status = useQuery({
    queryKey: [`minecraft-${kind}-restart`, serverId, identity],
    enabled: Boolean(identity),
    queryFn: async ({ signal }) =>
      restartSchema.parse(
        await api(`${serverPath(serverId)}/minecraft/${kind}/restart-status`, { signal }),
      ),
    refetchOnMount: 'always',
    staleTime: 5000,
    // Only a pending receipt needs a short observation retry after process start.
    // Ordinary Console refreshes do not list mods or query provider catalogs.
    refetchInterval: (query) =>
      query.state.data?.required && ['starting', 'running'].includes(state ?? '') ? 10000 : false,
    retry: false,
  });
  const observation = `${identity}:${serverId}:${kind}:${state}:${revision}`;
  const previous = useRef(observation);
  useEffect(() => {
    if (previous.current === observation) return;
    previous.current = observation;
    if (identity) void status.refetch();
  }, [observation, identity, status.refetch]);
  const lostAccess =
    status.error &&
    ['forbidden', 'unauthenticated', 'not_found'].includes(apiError(status.error).code);
  if (!identity || lostAccess || (!status.data?.required && !status.error)) return null;
  return (
    <div className="minecraft-mod-restart" role="status">
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M5.1 8a8 8 0 0 1 13.2-2L20 8M4 16l1.7 2A8 8 0 0 0 19 16" />
      </svg>
      <span>
        {t(
          kind === 'plugins'
            ? status.data?.required
              ? 'games.minecraft.plugins.restartRequired'
              : 'games.minecraft.plugins.restartUnavailable'
            : status.data?.required
              ? 'service.modsRestartRequired'
              : 'service.modsRestartUnavailable',
        )}
      </span>
      {status.error ? (
        <button
          type="button"
          className="minecraft-mod-restart-retry"
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
        >
          {t('web.retry')}
        </button>
      ) : (
        <Link to={`/servers/${encodeURIComponent(serverId)}/game/${kind}`}>
          {t(kind === 'plugins' ? 'games.minecraft.plugins.reviewInstalled' : 'service.modsReview')}
        </Link>
      )}
    </div>
  );
}
