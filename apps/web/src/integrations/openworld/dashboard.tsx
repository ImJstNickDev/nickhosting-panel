import type { UiSectionData } from '@nickhosting/game-sdk/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  dashboardStateSchema,
  dashboardStatusSchema,
} from '../../../../../games/openworld/src/dashboard-ui.js';
import { api } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { ErrorNotice, Loading, Notice, Section } from '../../components/ui.js';
import { Switch } from '../../components/workspace-controls.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';

import './dashboard.css';

export function OpenworldDashboard({
  data,
  serverId,
  pending,
  runtimeState,
}: GameSectionViewProps) {
  const t = useT();
  const cache = useQueryClient();
  const state = dashboardStateSchema.parse(data.metadata);
  const base = `/v1/servers/${serverId}/openworld/dashboard`;
  const live = useQuery({
    queryKey: ['openworld', serverId, 'dashboard-status'],
    queryFn: async ({ signal }) =>
      dashboardStatusSchema.parse(await api(`${base}/status`, { signal })),
    enabled: state.nativePrepared && runtimeState === 'running',
    retry: false,
  });
  const change = useMutation({
    mutationFn: async (enabled: boolean) =>
      dashboardStateSchema.parse(await api(base, { method: 'PUT', body: { enabled } })),
    onSuccess: async (confirmed) => {
      const queryKey = ['game-section', serverId, 'openworld', 'dashboard'];
      await cache.cancelQueries({ queryKey, exact: true });
      cache.setQueryData<UiSectionData>(queryKey, (current) =>
        current ? { ...current, metadata: confirmed } : current,
      );
    },
  });
  useEffect(() => {
    if (!state.hostname || !['pending', 'error'].includes(state.phase)) return;
    const interval = window.setInterval(
      () => {
        if (document.visibilityState === 'visible')
          void cache.refetchQueries({
            queryKey: ['game-section', serverId, 'openworld', 'dashboard'],
            exact: true,
            type: 'active',
          });
      },
      state.phase === 'pending' ? 3000 : 15000,
    );
    return () => clearInterval(interval);
  }, [state.phase, state.hostname, cache, serverId]);
  const address =
    state.phase === 'active' && state.hostname && state.canOpen
      ? `https://${state.hostname}`
      : null;
  return (
    <>
      {(state.canConfigure || state.canOpen) && (
        <Section title={t('games.openworld.dashboard.title')}>
          {state.canConfigure && (
            <Switch
              label={t('games.openworld.dashboard.enabled')}
              checked={state.enabled}
              disabled={pending || change.isPending || (!state.enabled && !state.hostname)}
              onChange={(enabled) => change.mutate(enabled)}
            />
          )}
          {change.error && <ErrorNotice error={change.error} />}
          {!state.hostname && state.canConfigure ? (
            <Notice>{t('games.openworld.dashboard.missing')}</Notice>
          ) : state.phase === 'pending' ? (
            <p role="status">{t('games.openworld.dashboard.pending')}</p>
          ) : state.phase === 'error' ? (
            <Notice>{t('games.openworld.dashboard.failed')}</Notice>
          ) : !state.canConfigure && !state.enabled ? (
            <Notice>{t('games.openworld.dashboard.unpublished')}</Notice>
          ) : null}
          {address && (
            <div className="openworld-dashboard-access">
              <a
                className="button"
                href={address}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                {t('games.openworld.dashboard.native')}
              </a>
              <span className="muted">{state.hostname}</span>
            </div>
          )}
        </Section>
      )}
      <Section
        title={t('games.openworld.dashboard.status')}
        actions={
          state.nativePrepared &&
          runtimeState === 'running' && (
            <button
              type="button"
              disabled={live.isFetching || pending}
              onClick={() => void live.refetch()}
            >
              {t('games.openworld.dashboard.refresh')}
            </button>
          )
        }
      >
        {!state.nativePrepared ? (
          <Notice>{t('games.openworld.dashboard.restart')}</Notice>
        ) : runtimeState !== 'running' ? (
          <Notice>{t('games.openworld.dashboard.offline')}</Notice>
        ) : live.isPending ? (
          <Loading />
        ) : live.error ? (
          <ErrorNotice error={live.error} />
        ) : (
          live.data && (
            <dl className="openworld-dashboard-metrics">
              <dt>{t('games.openworld.dashboard.players')}</dt>
              <dd>
                {live.data.players.online} / {live.data.players.slots}
              </dd>
              <dt>{t('games.openworld.dashboard.tps')}</dt>
              <dd>{Number(live.data.tps.toFixed(1))}</dd>
              <dt>{t('games.openworld.dashboard.memory')}</dt>
              <dd>{Math.round(live.data.memory.rssMB)} MB</dd>
            </dl>
          )
        )}
      </Section>
    </>
  );
}
