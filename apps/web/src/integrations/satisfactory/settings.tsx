import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { ErrorNotice } from '../../components/ui.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import './settings.css';

const key = (name: string) => `games.satisfactory.api.${name}`;
type State = {
  activeSessionName: string;
  numConnectedPlayers: number;
  playerLimit: number;
  averageTickRate: number;
  isGameRunning: boolean;
};
type Options = {
  serverOptions: Record<string, string>;
  pendingServerOptions: Record<string, string>;
};
export function SatisfactorySettingsSection(props: GameSectionViewProps) {
  const t = useT(),
    base = `/v1/servers/${encodeURIComponent(props.serverId)}/satisfactory/api`;
  const [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const config = useQuery({
    queryKey: ['satisfactory-api', props.serverId],
    queryFn: ({ signal }) => api<{ configured: boolean }>(base, { signal }),
  });
  const online = props.runtimeState === 'running' || props.runtimeState === 'online';
  const enabled = config.data?.configured === true && online;
  const state = useQuery({
    queryKey: ['satisfactory-state', props.serverId, props.runtimeState],
    enabled,
    queryFn: ({ signal }) => api<State>(`${base}/state`, { signal }),
    refetchInterval: 15000,
  });
  const options = useQuery({
    queryKey: ['satisfactory-options', props.serverId, props.runtimeState],
    enabled,
    queryFn: ({ signal }) => api<Options>(`${base}/options`, { signal }),
  });
  const editable = props.canManage && !props.pending && !busy;
  async function saveToken() {
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await api(`${base}/token`, { method: 'PUT', body: { token } });
      setToken('');
      setSaved(true);
      await config.refetch();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function saveOptions() {
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await api(`${base}/options`, { method: 'PUT', body: { options: draft } });
      setDraft({});
      setSaved(true);
      await options.refetch();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-surface satisfactory-settings">
      <h2>{t(key('title'))}</h2>
      {(error ?? config.error ?? state.error ?? options.error) != null && (
        <ErrorNotice error={error ?? config.error ?? state.error ?? options.error} />
      )}
      {config.isPending ? (
        <p role="status">{t('web.loading')}</p>
      ) : (
        <p>{t(key(config.data?.configured ? 'configured' : 'unconfigured'))}</p>
      )}
      {props.canManage && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveToken();
          }}
        >
          <p>{t(key('tokenHelp'))}</p>
          <label>
            {t(key('token'))}
            <input
              type="password"
              autoComplete="off"
              value={token}
              maxLength={8192}
              onChange={(event) => setToken(event.target.value)}
              disabled={!editable}
            />
          </label>
          <button type="submit" disabled={!editable || !online || token.length === 0}>
            {t('web.save')}
          </button>
        </form>
      )}
      {!online && <p>{t(key('startFirst'))}</p>}
      {saved && <p role="status">{t(key('saved'))}</p>}
      {enabled && state.isPending && <p role="status">{t('web.loading')}</p>}
      {state.data && online && (
        <dl>
          <dt>{t(key('session'))}</dt>
          <dd>{state.data.activeSessionName || '—'}</dd>
          <dt>{t(key('players'))}</dt>
          <dd>
            {state.data.numConnectedPlayers} / {state.data.playerLimit}
          </dd>
          <dt>{t(key('tickRate'))}</dt>
          <dd>{state.data.averageTickRate}</dd>
        </dl>
      )}
      {options.data && online && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveOptions();
          }}
        >
          <h3>{t(key('options'))}</h3>
          {Object.entries(options.data.serverOptions).map(([name, value]) => (
            <label key={name}>
              {name}
              <input
                value={draft[name] ?? value}
                disabled={!editable}
                maxLength={4096}
                onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
              />
              {options.data.pendingServerOptions[name] !== undefined && (
                <span>
                  {t(key('pending'))}: {options.data.pendingServerOptions[name]}
                </span>
              )}
            </label>
          ))}
          <button type="submit" disabled={!editable || Object.keys(draft).length === 0}>
            {t('web.save')}
          </button>
        </form>
      )}
    </section>
  );
}
