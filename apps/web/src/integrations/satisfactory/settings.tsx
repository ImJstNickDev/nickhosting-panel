import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { useUnsavedChanges } from '../../components/navigation-guard.js';
import { ErrorNotice, Input, Select } from '../../components/ui.js';
import '../../components/workspace-controls.css';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import { FicsitHeader } from './ficsit.js';
import './settings.css';

const key = (name: string) => `games.satisfactory.api.${name}`;
const optionLabels: Record<string, string> = {
  'FG.DSAutoPause': 'autoPause',
  'FG.AutosaveInterval': 'autosaveInterval',
  'FG.DSAutoSaveOnDisconnect': 'saveOnDisconnect',
  'FG.ServerRestartTimeSlot': 'restartTime',
  'FG.EnableSeasonalEvents': 'seasonalEvents',
  'FG.NetworkQuality': 'networkQuality',
  'FG.WeatherPreset': 'weatherPreset',
  'FG.GameRules.NoBuildCost': 'noBuildCost',
  'FG.GameRules.NoPower': 'noPower',
  'FG.GameRules.NoFuel': 'noFuel',
  'FG.GameRules.DisableArachnidCreatures': 'disableArachnids',
};

const booleanSettings = new Set([
  'FG.DSAutoPause',
  'FG.DSAutoSaveOnDisconnect',
  'FG.EnableSeasonalEvents',
  'FG.GameRules.NoBuildCost',
  'FG.GameRules.NoPower',
  'FG.GameRules.NoFuel',
  'FG.GameRules.DisableArachnidCreatures',
]);
function booleanLabel(name: string, value: string): string | undefined {
  if (!booleanSettings.has(name)) return undefined;
  if (/^(true|1)$/i.test(value)) return key('enabled');
  if (/^(false|0)$/i.test(value)) return key('disabled');
  return undefined;
}
function SettingField({
  name,
  value,
  disabled,
  hint,
  onChange,
}: {
  name: string;
  value: string;
  disabled: boolean;
  hint?: string;
  onChange: (event: { target: { value: string } }) => void;
}) {
  const t = useT();
  const label =
    name === 'FG.GameRules.NoBuildCost'
      ? t(key('advanced.noBuildCost'))
      : optionLabels[name]
        ? t(key(`option.${optionLabels[name]}`))
        : name;
  const booleanSetting = booleanSettings.has(name);
  const booleanValues =
    booleanSetting && /^(true|false)$/i.test(value)
      ? value === value.toUpperCase()
        ? ['FALSE', 'TRUE']
        : /^[A-Z]/.test(value)
          ? ['False', 'True']
          : ['false', 'true']
      : /^(0|1)$/.test(value) && booleanSetting
        ? ['0', '1']
        : undefined;
  return booleanValues ? (
    <div className="satisfactory-setting-choice">
      <Select label={label} value={value} disabled={disabled} onChange={onChange}>
        {booleanValues.map((item, index) => (
          <option key={item} value={item}>
            {t(key(index ? 'enabled' : 'disabled'))}
          </option>
        ))}
      </Select>
      {hint && <small>{hint}</small>}
    </div>
  ) : (
    <Input
      label={label}
      hint={hint}
      value={value}
      disabled={disabled}
      maxLength={4096}
      onChange={onChange}
    />
  );
}

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
  const submitting = useRef(false);
  const [replaceToken, setReplaceToken] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [advancedDraft, setAdvancedDraft] = useState<Record<string, string>>({});
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [draftSession, setDraftSession] = useState<string>();
  useUnsavedChanges(
    token.length > 0 || Object.keys(draft).length > 0 || Object.keys(advancedDraft).length > 0,
    busy,
  );
  const config = useQuery({
    queryKey: ['satisfactory-api', props.serverId],
    queryFn: ({ signal }) => api<{ configured: boolean }>(base, { signal }),
  });
  const online = props.runtimeState === 'running' || props.runtimeState === 'online';
  const enabled = config.data?.configured === true && online;
  const options = useQuery({
    queryKey: ['satisfactory-options', props.serverId, props.runtimeState],
    enabled,
    queryFn: ({ signal }) => api<Options>(`${base}/options`, { signal }),
  });
  const advanced = useQuery({
    queryKey: ['satisfactory-advanced-settings', props.serverId, props.runtimeState],
    enabled,
    queryFn: ({ signal }) =>
      api<{
        sessionName: string;
        creativeModeEnabled: boolean;
        advancedGameSettings: Record<string, string>;
      }>(`${base}/advanced-settings`, { signal }),
  });
  const editable = props.canManage && !props.pending && !busy;
  async function saveToken() {
    if (!editable || !online || token.length === 0) return;
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await api(`${base}/token`, { method: 'PUT', body: { token } });
      setToken('');
      setReplaceToken(false);
      setSaved(true);
      await config.refetch();
      await Promise.all([options.refetch(), advanced.refetch()]);
    } catch (cause) {
      setError(cause);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function saveOptions() {
    if (!editable || !online || Object.keys(draft).length === 0) return;
    if (submitting.current) return;
    submitting.current = true;
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
      submitting.current = false;
      setBusy(false);
    }
  }
  async function saveAdvanced() {
    if (
      !editable ||
      !online ||
      !advanced.data ||
      !draftSession ||
      draftSession !== advanced.data.sessionName ||
      Object.keys(advancedDraft).length === 0 ||
      (!advanced.data.creativeModeEnabled && !confirmEnable)
    )
      return;
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await api(`${base}/advanced-settings`, {
        method: 'PUT',
        body: {
          settings: advancedDraft,
          expectedSessionName: draftSession,
          confirmEnable,
        },
      });
      setAdvancedDraft({});
      setDraftSession(undefined);
      setConfirmEnable(false);
      setSaved(true);
      await advanced.refetch();
    } catch (cause) {
      setError(cause);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="workspace-surface ficsit-surface satisfactory-settings">
      <FicsitHeader title={t(key('title'))} />
      <div className="satisfactory-settings-body">
        {(error ?? config.error ?? options.error ?? advanced.error) != null && (
          <ErrorNotice error={error ?? config.error ?? options.error ?? advanced.error} />
        )}
        {config.isPending ? (
          <p role="status">{t('web.loading')}</p>
        ) : (
          <p>
            {t(
              key(
                config.data?.configured
                  ? online && options.isSuccess && !options.isError
                    ? 'connected'
                    : 'configured'
                  : 'unconfigured',
              ),
            )}
          </p>
        )}
        {props.canManage && config.data?.configured && !replaceToken && (
          <button
            type="button"
            className="secondary satisfactory-token-toggle"
            onClick={() => setReplaceToken(true)}
          >
            {t(key('replaceToken'))}
          </button>
        )}
        {props.canManage && (!config.data?.configured || replaceToken) && (
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
              hint={
                online && options.isSuccess && !options.isError ? undefined : t(key('tokenHelp'))
              }
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
        {enabled && (options.isPending || advanced.isPending) && (
          <p role="status">{t('web.loading')}</p>
        )}
        {(config.isError || options.isError || advanced.isError) && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void config.refetch();
              if (enabled) {
                void options.refetch();
                void advanced.refetch();
              }
            }}
          >
            {t(key('retry'))}
          </button>
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
            {Object.keys(options.data.serverOptions).length === 0 && (
              <p>{t(key('optionsEmpty'))}</p>
            )}
            <div className="satisfactory-option-fields">
              {Object.entries(options.data.serverOptions).map(([name, value]) => (
                <SettingField
                  key={name}
                  name={name}
                  hint={
                    options.data.pendingServerOptions[name] !== undefined
                      ? `${t(key('pending'))}: ${booleanLabel(name, options.data.pendingServerOptions[name]) ? t(booleanLabel(name, options.data.pendingServerOptions[name]) as string) : options.data.pendingServerOptions[name]}`
                      : undefined
                  }
                  value={draft[name] ?? value}
                  disabled={!editable}
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
        {advanced.data && online && (
          <form
            className="satisfactory-settings-options"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void saveAdvanced();
            }}
          >
            <h3>{t(key('advancedTitle'))}</h3>
            <p>{t(key('advancedHelp'))}</p>
            {!advanced.data.sessionName && <p>{t(key('advancedNoWorld'))}</p>}
            {draftSession && draftSession !== advanced.data.sessionName && (
              <p role="alert">{t(key('advancedWorldChanged'))}</p>
            )}
            <p>
              {t(key(advanced.data.creativeModeEnabled ? 'advancedEnabled' : 'advancedDisabled'))}
            </p>
            {Object.keys(advanced.data.advancedGameSettings).length === 0 && (
              <p>{t(key('advancedEmpty'))}</p>
            )}
            <div className="satisfactory-option-fields">
              {Object.entries(advanced.data.advancedGameSettings).map(([name, value]) => (
                <SettingField
                  key={name}
                  name={name}
                  value={advancedDraft[name] ?? value}
                  disabled={!editable || !advanced.data.sessionName}
                  onChange={(event) => {
                    setSaved(false);
                    if (Object.keys(advancedDraft).length === 0)
                      setDraftSession(advanced.data?.sessionName);
                    const next = { ...advancedDraft };
                    if (event.target.value === value) delete next[name];
                    else next[name] = event.target.value;
                    setAdvancedDraft(next);
                  }}
                />
              ))}
            </div>
            {!advanced.data.creativeModeEnabled && (
              <label className="satisfactory-settings-confirm">
                <input
                  type="checkbox"
                  checked={confirmEnable}
                  disabled={!editable || !advanced.data.sessionName}
                  onChange={(event) => setConfirmEnable(event.target.checked)}
                />
                {t(key('advancedConfirm'))}
              </label>
            )}
            <div className="form-footer">
              <button
                type="button"
                className="secondary"
                disabled={!editable || Object.keys(advancedDraft).length === 0}
                onClick={() => {
                  setAdvancedDraft({});
                  setDraftSession(undefined);
                  setConfirmEnable(false);
                }}
              >
                {t('web.cancel')}
              </button>
              <button
                type="submit"
                disabled={
                  !editable ||
                  Object.keys(advancedDraft).length === 0 ||
                  draftSession !== advanced.data.sessionName ||
                  (!advanced.data.creativeModeEnabled && !confirmEnable)
                }
              >
                {t('web.save')}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
