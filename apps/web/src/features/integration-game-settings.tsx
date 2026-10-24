import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api, queryClient } from '../api/client.js';
import { useT } from '../app/i18n.js';
import {
  ActionForm,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Section,
  Select,
  Textarea,
} from '../components/ui.js';

type Messages = Partial<
  Record<'motd' | 'disconnect' | 'legacyDisconnect', Record<string, { en: string; it: string }>>
> & {
  fallbackProtocol?: number;
  legacyProtocol?: number;
  versionName?: string;
  onlinePlayers?: number;
  maximumPlayers?: number;
  legacyLineSeparator?: string;
};
type Settings = { config: { values: Record<string, unknown>; lockedKeys: string[] } };
function useSettings() {
  return useQuery({
    queryKey: ['owner-settings'],
    queryFn: () => api<Settings>('/v1/owner/settings'),
  });
}
const states = [
  'sleeping',
  'waking',
  'stopping',
  'blocked',
  'maintenance',
  'manually_stopped',
  'online',
] as const;
const numeric = ['fallbackProtocol', 'legacyProtocol', 'onlinePlayers', 'maximumPlayers'] as const;
const textual = ['versionName', 'legacyLineSeparator'] as const;

/** Only the statically registered Minecraft contribution mounts these game settings. */
export function MinecraftResponseSettings() {
  const t = useT(),
    settings = useSettings();
  return (
    <Section title={t('integrationConfig.messages')}>
      {settings.isPending ? (
        <Loading />
      ) : settings.error ? (
        <ErrorNotice error={settings.error} />
      ) : (
        <ResponseForm
          key={JSON.stringify(settings.data.config.values.minecraftGatewayResponses)}
          initial={(settings.data.config.values.minecraftGatewayResponses ?? {}) as Messages}
          locked={settings.data.config.lockedKeys.includes('minecraftGatewayResponses')}
          onSaved={() => settings.refetch()}
        />
      )}
    </Section>
  );
}
function ResponseForm({
  initial,
  locked,
  onSaved,
}: {
  initial: Messages;
  locked: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<(typeof states)[number]>('sleeping');
  const [kind, setKind] = useState<'motd' | 'disconnect' | 'legacyDisconnect'>('motd');
  const message = value[kind]?.[state];
  return (
    <fieldset disabled={locked}>
      {locked && <Notice>{t('owner.environmentLocked')}</Notice>}
      <ActionForm
        onSubmit={async (data) => {
          for (const group of ['motd', 'disconnect', 'legacyDisconnect'] as const) {
            for (const entry of states) {
              const translated = value[group]?.[entry];
              if (translated && (!translated.en.trim() || !translated.it.trim())) {
                setKind(group);
                setState(entry);
                throw new ApiError('validation_failed', 'integrationConfig.bothLanguages');
              }
            }
          }
          const next: Messages = { ...value };
          for (const key of numeric) {
            const raw = String(data.get(key) ?? '').trim();
            if (raw) next[key] = Number(raw);
            else delete next[key];
          }
          for (const key of textual) {
            const raw = String(data.get(key) ?? '');
            if (raw) next[key] = raw;
            else delete next[key];
          }
          await api('/v1/owner/settings', {
            method: 'PATCH',
            body: { minecraftGatewayResponses: next },
          });
          await onSaved();
        }}
      >
        <div className="integration-settings-grid">
          <Select
            label={t('web.status')}
            value={state}
            onChange={(e) => setState(e.target.value as typeof state)}
          >
            {states.map((s) => (
              <option key={s} value={s}>
                {t(s === 'stopping' ? 'platform.stopping' : `gateway.states.${s}`)}
              </option>
            ))}
          </Select>
          <Select
            label={t('integrationConfig.response')}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            {(['motd', 'disconnect', 'legacyDisconnect'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`integrationConfig.${k}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="integration-settings-grid">
          {(['en', 'it'] as const).map((locale) => (
            <Textarea
              key={locale}
              label={t(`integrationConfig.${locale}`)}
              value={message?.[locale] ?? ''}
              placeholder={t('integrationConfig.defaultText')}
              maxLength={512}
              required={Boolean(message?.en || message?.it)}
              onChange={(e) => {
                const text = e.target.value;
                setValue((old) => {
                  const group = { ...old[kind] };
                  const translated = { en: '', it: '', ...group[state], [locale]: text };
                  if (!translated.en && !translated.it) delete group[state];
                  else group[state] = translated;
                  return { ...old, [kind]: group };
                });
              }}
            />
          ))}
        </div>
        <details>
          <summary>{t('integrationConfig.advanced')}</summary>
          <div className="integration-settings-grid">
            {numeric.map((key) => (
              <Input
                key={key}
                label={t(`integrationConfig.${key}`)}
                name={key}
                type="number"
                min={0}
                max={
                  key === 'legacyProtocol' ? 255 : key === 'fallbackProtocol' ? 2147483647 : 1000000
                }
                step={1}
                defaultValue={initial[key] ?? ''}
              />
            ))}
            {textual.map((key) => (
              <Input
                key={key}
                label={t(`integrationConfig.${key}`)}
                name={key}
                defaultValue={initial[key] ?? ''}
                maxLength={key === 'versionName' ? 64 : 16}
              />
            ))}
          </div>
        </details>
      </ActionForm>
    </fieldset>
  );
}
export function MinecraftProtocolSettings({ embedded = false }: { embedded?: boolean }) {
  const t = useT(),
    settings = useSettings();
  if (settings.isPending) return <Loading />;
  if (settings.error) return <ErrorNotice error={settings.error} />;
  const value = settings.data.config.values.minecraftProtocolSource as
    | { commit: string; sha256: string }
    | undefined;
  const locked = settings.data.config.lockedKeys.includes('minecraftProtocolSource');
  const form = (
    <fieldset disabled={locked}>
      {locked && <Notice>{t('owner.environmentLocked')}</Notice>}
      <ActionForm
        key={JSON.stringify(value)}
        onSubmit={async (data) => {
          const commit = String(data.get('commit') ?? '').trim(),
            sha256 = String(data.get('sha256') ?? '').trim();
          if (!commit && !sha256)
            await api('/v1/owner/settings/minecraftProtocolSource', { method: 'DELETE' });
          else
            await api('/v1/owner/settings', {
              method: 'PATCH',
              body: { minecraftProtocolSource: { commit, sha256 } },
            });
          await settings.refetch();
        }}
      >
        <Input
          label={t('integrationConfig.commit')}
          name="commit"
          defaultValue={value?.commit ?? ''}
          pattern="[a-f0-9]{40}"
        />
        <Input
          label={t('integrationConfig.sha256')}
          name="sha256"
          defaultValue={value?.sha256 ?? ''}
          pattern="[a-f0-9]{64}"
        />
      </ActionForm>
    </fieldset>
  );
  return embedded ? (
    form
  ) : (
    <details>
      <summary>{t('integrationConfig.protocolSource')}</summary>
      {form}
    </details>
  );
}

export function MinecraftModSettings() {
  const t = useT(),
    settings = useSettings();
  const setting = 'minecraftModAlternativeLimit';
  const locked = settings.data?.config.lockedKeys.includes(setting) ?? false;
  return (
    <Section title={t('integrationConfig.modAlternatives')}>
      {settings.isPending ? (
        <Loading />
      ) : settings.error ? (
        <ErrorNotice error={settings.error} retry={() => void settings.refetch()} />
      ) : (
        <fieldset disabled={locked}>
          {locked && <Notice>{t('owner.environmentLocked')}</Notice>}
          <ActionForm
            key={String(settings.data.config.values[setting])}
            onSubmit={async (form) => {
              await api('/v1/owner/settings', {
                method: 'PATCH',
                body: { [setting]: Number(form.get(setting)) },
              });
              await queryClient.invalidateQueries({ queryKey: ['minecraft-mod-alternatives'] });
              await settings.refetch();
            }}
          >
            <div className="integration-settings-grid">
              <Input
                label={t('integrationConfig.modAlternativeLimit')}
                name={setting}
                type="number"
                min={1}
                max={250}
                step={1}
                required
                defaultValue={Number(settings.data.config.values[setting] ?? 25)}
              />
            </div>
            <small className="muted">{t('integrationConfig.modAlternativeHint')}</small>
          </ActionForm>
        </fieldset>
      )}
    </Section>
  );
}
