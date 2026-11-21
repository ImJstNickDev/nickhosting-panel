import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
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
  canManage,
  pending,
  runtimeState,
  reload,
}: GameSectionViewProps) {
  const t = useT();
  const state = dashboardStateSchema.parse(data.metadata);
  const base = `/v1/servers/${serverId}/openworld/dashboard`;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [secret, setSecret] = useState('');
  const canConfigure = canManage && state.canConfigure;
  const live = useQuery({
    queryKey: ['openworld', serverId, 'dashboard-status'],
    queryFn: async ({ signal }) =>
      dashboardStatusSchema.parse(await api(`${base}/status`, { signal })),
    enabled: state.enabled && runtimeState === 'running',
    retry: false,
  });
  async function change(enabled: boolean) {
    setBusy(true);
    setSecret('');
    setError(undefined);
    try {
      await api(base, { method: 'PUT', body: { enabled } });
      await reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function reveal() {
    if (secret) {
      setSecret('');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setSecret((await api<{ password: string }>(`${base}/password`, { method: 'POST' })).password);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Section title={t('games.openworld.dashboard.title')}>
        <Switch
          label={t('games.openworld.dashboard.enabled')}
          checked={state.enabled}
          help={t('games.openworld.dashboard.apply')}
          disabled={!canConfigure || pending || busy}
          onChange={(enabled) => void change(enabled)}
        />
        {Boolean(error) && <ErrorNotice error={error} />}
        {state.enabled && canConfigure && state.privateAddress && (
          <div className="openworld-dashboard-access">
            <p>{t('games.openworld.dashboard.private')}</p>
            <div className="actions">
              <a
                className="button"
                href={state.privateAddress}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                {t('games.openworld.dashboard.native')}
              </a>
              <button
                type="button"
                disabled={busy || pending}
                className="secondary"
                onClick={() => void reveal()}
              >
                {t(secret ? 'games.openworld.dashboard.hide' : 'games.openworld.dashboard.show')}
              </button>
            </div>
            {secret && (
              <output className="openworld-dashboard-password" aria-live="polite">
                {secret}
              </output>
            )}
          </div>
        )}
      </Section>
      {state.enabled && (
        <Section
          title={t('games.openworld.dashboard.status')}
          actions={
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
          {runtimeState !== 'running' ? (
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
      )}
    </>
  );
}
