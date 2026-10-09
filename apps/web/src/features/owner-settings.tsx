import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import {
  ActionForm,
  Check,
  Dialog,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Page,
  Section,
  Select,
  Textarea,
  text,
} from '../components/ui.js';

type Schema = {
  type?: string | string[];
  enum?: Array<string | number>;
  anyOf?: Schema[];
  oneOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};
type Settings = {
  config: {
    values: Record<string, unknown>;
    sources: Record<string, string>;
    lockedKeys: string[];
  };
  secrets: Array<{ name: string; configured: boolean; source: string; locked: boolean }>;
};
const groupFor = (key: string) =>
  key.startsWith('smtp') || key.startsWith('discord') || /registration|support|session/.test(key)
    ? 'identity'
    : key.startsWith('pterodactyl') || key === 'dockerObserverSocket'
      ? 'provider'
      : key.startsWith('gateway')
        ? 'gateway'
        : key.startsWith('minecraft')
          ? 'content'
          : key.startsWith('sftp')
            ? 'sftp'
            : /dns|cloudflare|staticGame/.test(key)
              ? 'network'
              : /defaultUser|storage|Servers|Provisions|observation/.test(key)
                ? 'resources'
                : 'general';
const groups = [
  'general',
  'identity',
  'resources',
  'provider',
  'gateway',
  'sftp',
  'network',
  'content',
];
export function OwnerSettingsPage() {
  const t = useT(),
    session = useSession();
  const editable =
    session.data?.context.role === 'owner' && session.data?.context.sessionType === 'regular';
  const settings = useQuery({
    queryKey: ['owner-settings'],
    queryFn: () => api<Settings>('/v1/owner/settings'),
  });
  const schema = useQuery({
    queryKey: ['owner-settings-schema'],
    queryFn: () => api<Schema>('/v1/owner/settings/schema'),
  });
  const [reset, setReset] = useState<string>();
  if (settings.isPending || schema.isPending) return <Loading />;
  if (settings.error || schema.error) return <ErrorNotice error={settings.error ?? schema.error} />;
  const value = settings.data;
  return (
    <Page title={t('owner.platformSettings')}>
      <Notice>{t('owner.precedence')}</Notice>
      {groups.map((group) => (
        <Section title={t(`owner.group.${group}`)} key={group}>
          <div className="settings-list">
            {Object.entries(schema.data.properties ?? {})
              .filter(([key]) => groupFor(key) === group)
              .map(([key, definition]) => (
                <details key={`${key}:${JSON.stringify(value.config.values[key])}`}>
                  <summary>
                    <span>{t(`owner.config.${key}`)}</span>
                    <small>{t(`owner.source.${value.config.sources[key] ?? 'default'}`)}</small>
                  </summary>
                  {!editable || value.config.lockedKeys.includes(key) ? (
                    <>
                      <Notice>
                        {t(editable ? 'owner.environmentLocked' : 'owner.readOnlySettings')}
                      </Notice>
                      <pre>
                        {value.config.values[key] === undefined
                          ? '—'
                          : JSON.stringify(value.config.values[key], null, 2)}
                      </pre>
                    </>
                  ) : (
                    <SettingForm
                      settingKey={key}
                      definition={definition}
                      value={value.config.values[key]}
                      onSaved={async () => {
                        await settings.refetch();
                      }}
                    />
                  )}
                  {editable &&
                    value.config.sources[key] === 'database' &&
                    !value.config.lockedKeys.includes(key) && (
                      <button type="button" className="secondary" onClick={() => setReset(key)}>
                        {t('owner.resetSetting')}
                      </button>
                    )}
                </details>
              ))}
          </div>
        </Section>
      ))}
      <Section title={t('owner.credentials')}>
        <p className="muted">{t('owner.writeOnly')}</p>
        <div className="settings-list">
          {value.secrets.map((secret) => (
            <details key={secret.name}>
              <summary>
                {t(`owner.secret.${secret.name}`)}{' '}
                <small>{t(secret.configured ? 'owner.configured' : 'web.unconfigured')}</small>
              </summary>
              {!editable || secret.locked ? (
                <Notice>
                  {t(editable ? 'owner.environmentLocked' : 'owner.readOnlySettings')}
                </Notice>
              ) : (
                <SecretForm
                  name={secret.name}
                  onSaved={async () => {
                    await settings.refetch();
                  }}
                />
              )}
            </details>
          ))}
        </div>
      </Section>
      <Dialog
        open={Boolean(reset)}
        title={t('owner.resetSetting')}
        onClose={() => setReset(undefined)}
      >
        {reset && (
          <ActionForm
            success={false}
            submitLabel={t('web.confirm')}
            onSubmit={async () => {
              await api(`/v1/owner/settings/${encodeURIComponent(reset)}`, { method: 'DELETE' });
              setReset(undefined);
              await settings.refetch();
            }}
          >
            <p>{t('owner.resetWarning', { name: t(`owner.config.${reset}`) })}</p>
            <Check required label={t('web.confirm')} />
          </ActionForm>
        )}
      </Dialog>
    </Page>
  );
}
function shape(schema: Schema): Schema {
  const types = schema.anyOf ?? schema.oneOf;
  if (types) {
    const candidate = types.find((entry) => entry.type && entry.type !== 'null');
    if (candidate) return candidate;
  }
  return schema;
}
function SettingForm({
  settingKey,
  definition,
  value,
  onSaved,
}: {
  settingKey: string;
  definition: Schema;
  value: unknown;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const schema = shape(definition);
  const kind = Array.isArray(schema.type)
    ? schema.type.find((type) => type !== 'null')
    : schema.type;
  const nullable =
    (Array.isArray(definition.type) && definition.type.includes('null')) ||
    (definition.anyOf ?? []).some((item) => item.type === 'null');
  const [noLimit, setNoLimit] = useState(value === null);
  const primitiveArray = kind === 'array' && schema.items?.type === 'string';
  const complex =
    kind === 'object' || (kind === 'array' && !primitiveArray) || (!kind && !schema.enum);
  return (
    <ActionForm
      onSubmit={async (data) => {
        let next: unknown;
        if (nullable && noLimit) next = null;
        else if (kind === 'boolean') next = data.has('value');
        else if (kind === 'integer' || kind === 'number') next = Number(data.get('value'));
        else if (primitiveArray)
          next = String(data.get('value') ?? '')
            .split('\n')
            .map((v) => v.trim())
            .filter(Boolean);
        else if (complex) {
          try {
            next = JSON.parse(String(data.get('value')));
          } catch {
            throw new ApiError('validation_failed', 'owner.invalidJson');
          }
        } else next = String(data.get('value') ?? '');
        await api('/v1/owner/settings', { method: 'PATCH', body: { [settingKey]: next } });
        await onSaved();
      }}
    >
      {nullable && (
        <Check
          checked={noLimit}
          onChange={(event) => setNoLimit(event.target.checked)}
          label={t('owner.noCountLimit')}
        />
      )}
      {!(nullable && noLimit) &&
        (schema.enum ? (
          <Select
            name="value"
            label={t(`owner.config.${settingKey}`)}
            defaultValue={value === undefined ? '' : String(value)}
          >
            {schema.enum.map((option) => (
              <option key={option} value={option}>
                {String(option)}
              </option>
            ))}
          </Select>
        ) : kind === 'boolean' ? (
          <Check name="value" defaultChecked={value === true} label={t('web.enabled')} />
        ) : primitiveArray ? (
          <Textarea
            label={t(`owner.config.${settingKey}`)}
            name="value"
            defaultValue={Array.isArray(value) ? value.join('\n') : ''}
          />
        ) : complex ? (
          <>
            <p className="muted">{t('owner.structuredConfig')}</p>
            <Textarea
              className="file-editor"
              label={t(`owner.config.${settingKey}`)}
              name="value"
              defaultValue={value === undefined ? '' : JSON.stringify(value, null, 2)}
              required
              spellCheck={false}
            />
          </>
        ) : (
          <Input
            label={t(`owner.config.${settingKey}`)}
            name="value"
            type={kind === 'integer' || kind === 'number' ? 'number' : 'text'}
            defaultValue={value === undefined ? '' : String(value)}
            required
            min={schema.minimum}
            max={schema.maximum}
            step={kind === 'number' ? 'any' : 1}
            minLength={schema.minLength}
            maxLength={schema.maxLength}
          />
        ))}
      {primitiveArray && <small>{t('owner.onePerLine')}</small>}
    </ActionForm>
  );
}
function SecretForm({ name, onSaved }: { name: string; onSaved: () => Promise<void> }) {
  const t = useT();
  const [value, setValue] = useState('');
  return (
    <ActionForm
      onSubmit={async () => {
        await api(`/v1/owner/secrets/${name}`, { method: 'PUT', body: { value } });
        setValue('');
        await onSaved();
      }}
    >
      <Input
        label={t('owner.newCredential')}
        name="value"
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        required
        maxLength={4096}
      />
    </ActionForm>
  );
}
