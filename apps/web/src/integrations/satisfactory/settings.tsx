import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client.js';
import { useFormat, useT } from '../../app/i18n.js';
import { useUnsavedChanges } from '../../components/navigation-guard.js';
import { Details, ErrorNotice, Input } from '../../components/ui.js';
import '../../components/workspace-controls.css';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import './settings.css';

const key = (name: string) => `games.satisfactory.api.${name}`;
const optionLabels: Record<string, string> = {
  'FG.DSAutoPause': 'autoPause',
  'FG.AutosaveInterval': 'autosaveInterval',
};
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
  const format = useFormat();
  const [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  useUnsavedChanges(token.length > 0 || Object.keys(draft).length > 0, busy);
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
    if (!editable || !online || token.length === 0) return;
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
    if (!editable || !online || Object.keys(draft).length === 0) return;
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
          className="satisfactory-settings-connection"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void saveToken();
          }}
        >
          <Input
            label={t(key('token'))}
            hint={t(key('tokenHelp'))}
            type="password"
            autoComplete="off"
            value={token}
            maxLength={8192}
            onChange={(event) => setToken(event.target.value)}
            disabled={!editable}
          />
          <div className="form-footer">
            <button type="submit" disabled={!editable || !online || token.length === 0}>
              {t('web.save')}
            </button>
          </div>
        </form>
      )}
      {!online && <p>{t(key('startFirst'))}</p>}
      {saved && <p role="status">{t(key('saved'))}</p>}
      {enabled && state.isPending && <p role="status">{t('web.loading')}</p>}
      {state.data && online && (
        <Details
          values={[
            [t(key('session')), state.data.activeSessionName || '—'],
            [t(key('players')), `${state.data.numConnectedPlayers} / ${state.data.playerLimit}`],
            [t(key('tickRate')), format.number(state.data.averageTickRate)],
          ]}
        />
      )}
      {options.data && online && (
        <form
          className="satisfactory-settings-options"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void saveOptions();
          }}
        >
          <h3>{t(key('options'))}</h3>
          <div className="satisfactory-option-fields">
            {Object.entries(options.data.serverOptions).map(([name, value]) => (
              <Input
                key={name}
                label={optionLabels[name] ? t(key(`option.${optionLabels[name]}`)) : name}
                hint={
                  options.data.pendingServerOptions[name] !== undefined
                    ? `${t(key('pending'))}: ${options.data.pendingServerOptions[name]}`
                    : undefined
                }
                value={draft[name] ?? value}
                disabled={!editable}
                maxLength={4096}
                onChange={(event) => {
                  setSaved(false);
                  const next = { ...draft };
                  if (event.target.value === value) delete next[name];
                  else next[name] = event.target.value;
                  setDraft(next);
                }}
              />
            ))}
          </div>
          <div className="form-footer">
            <button
              type="button"
              className="secondary"
              disabled={!editable || Object.keys(draft).length === 0}
              onClick={() => setDraft({})}
            >
              {t('web.cancel')}
            </button>
            <button type="submit" disabled={!editable || Object.keys(draft).length === 0}>
              {t('web.save')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
