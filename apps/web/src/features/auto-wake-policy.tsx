import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ActionForm, ErrorNotice, Notice, Select } from '../components/ui.js';
import { PolicyChoices, PolicyForm, PolicyHeading } from './server-automation-controls.js';
import { platformPath } from './service-contracts.js';
import './automation.css';

export type WakeAccess = 'hidden' | 'editable' | 'disable-only';
interface WakePolicy {
  effectiveEnabled: boolean;
  source: 'default' | 'game' | 'runtime' | 'server';
  overrideEnabled: boolean | null;
  inheritedEnabled: boolean;
  userAccess: WakeAccess;
  ownerBaselineEnabled: boolean;
  ownerUserAccessOverride?: WakeAccess | null;
  inheritedUserAccess?: WakeAccess;
}
export function WakeValue({
  name,
  value,
  inherited,
  disabled = false,
  enableAllowed = true,
  onChange,
}: {
  name: string;
  value: boolean | null;
  inherited?: boolean;
  disabled?: boolean;
  enableAllowed?: boolean;
  onChange?: (value: boolean | null) => void;
}) {
  const t = useT();
  return (
    <Select
      label={t('automation.autoWake')}
      className="automation-label-hidden"
      name={name}
      defaultValue={value === null ? 'inherit' : String(value)}
      disabled={disabled}
      onChange={(event) =>
        onChange?.(event.target.value === 'inherit' ? null : event.target.value === 'true')
      }
    >
      {inherited !== undefined && (
        <option value="inherit">
          {t('sleepTiming.inherit', { value: t(inherited ? 'web.enabled' : 'web.disabled') })}
        </option>
      )}
      <option value="true" disabled={!enableAllowed}>
        {t('web.enabled')}
      </option>
      <option value="false">{t('web.disabled')}</option>
    </Select>
  );
}
export function WakeAccessField({
  name,
  value,
  inherited,
  disabled = false,
  onChange,
}: {
  name: string;
  value: WakeAccess | null;
  inherited?: WakeAccess;
  disabled?: boolean;
  onChange?: (value: WakeAccess | null) => void;
}) {
  const t = useT();
  return (
    <Select
      name={name}
      label={t('sleepTiming.userAccess')}
      defaultValue={value ?? 'inherit'}
      disabled={disabled}
      onChange={(event) =>
        onChange?.(event.target.value === 'inherit' ? null : (event.target.value as WakeAccess))
      }
    >
      {inherited && (
        <option value="inherit">
          {t('sleepTiming.inherit', { value: t(`automation.access.${inherited}`) })}
        </option>
      )}
      {(['hidden', 'editable', 'disable-only'] as const).map((access) => (
        <option key={access} value={access}>
          {t(`automation.access.${access}`)}
        </option>
      ))}
    </Select>
  );
}
const readEnabled = (data: FormData, name: string) =>
  data.get(name) === 'inherit' ? null : data.get(name) === 'true';
const readAccess = (data: FormData, name: string) =>
  data.get(name) === 'inherit' ? null : data.get(name);
export function ServerWakeSettings({
  serverId,
  editable,
  owner,
}: {
  serverId: string;
  editable: boolean;
  owner: boolean;
}) {
  const t = useT();
  const policy = useQuery({
    queryKey: ['auto-wake-policy', serverId],
    queryFn: () => api<WakePolicy | null>(`${platformPath(serverId)}/auto-wake-policy`),
  });
  if (policy.error && !policy.data) return <ErrorNotice error={policy.error} />;
  if (policy.isPending)
    return (
      <div
        role="status"
        className="automation-skeleton"
        aria-label={t('web.loading')}
        aria-busy="true"
      />
    );
  if (!policy.data) return null;
  const value = policy.data;
  return (
    <section className="automation-policy sleep-wake-policy">
      <PolicyHeading
        kind="wake"
        title={t('automation.autoWake')}
        value={t(value.effectiveEnabled ? 'web.enabled' : 'web.disabled')}
        source={value.source}
      />
      <div className="sleep-wake-controls">
        {policy.error && <ErrorNotice error={policy.error} />}
        {editable && (
          <ServerWakeEditor
            key={JSON.stringify([
              value.overrideEnabled,
              value.inheritedEnabled,
              owner ? null : value.userAccess,
            ])}
            value={value}
            owner={owner}
            onSubmit={async (data) => {
              await api(`${platformPath(serverId)}/auto-wake-policy`, {
                method: 'PUT',
                body: {
                  overrideEnabled: readEnabled(data, 'wake'),
                },
              });
              await policy.refetch();
            }}
          />
        )}
        {!editable && (
          <p className="sleep-wake-hint">
            {t(
              value.effectiveEnabled ? 'automation.wakeEnabledHint' : 'automation.wakeDisabledHint',
            )}
          </p>
        )}
      </div>
    </section>
  );
}
function ServerWakeEditor({
  value,
  owner,
  onSubmit,
}: {
  value: WakePolicy;
  owner: boolean;
  onSubmit: (data: FormData) => Promise<unknown>;
}) {
  const t = useT();
  const [wake, setWake] = useState(
    value.overrideEnabled === null ? 'inherit' : String(value.overrideEnabled),
  );
  const dirty =
    wake !== (value.overrideEnabled === null ? 'inherit' : String(value.overrideEnabled));
  return (
    <PolicyForm
      dirty={dirty}
      onSubmit={onSubmit}
      onCancel={() => {
        setWake(value.overrideEnabled === null ? 'inherit' : String(value.overrideEnabled));
      }}
    >
      <input type="hidden" name="wake" value={wake} />
      <PolicyChoices
        label={t('automation.autoWake')}
        value={wake}
        onChange={setWake}
        options={[
          { value: 'inherit', label: t('automation.inherit') },
          {
            value: 'true',
            label: t('web.enabled'),
            disabled: !owner && value.userAccess === 'disable-only',
          },
          { value: 'false', label: t('web.disabled') },
        ]}
      />
      <p className="sleep-wake-hint">
        {t(
          wake === 'inherit'
            ? value.inheritedEnabled
              ? 'automation.wakeInheritEnabledHint'
              : 'automation.wakeInheritDisabledHint'
            : wake === 'true'
              ? 'automation.wakeEnabledHint'
              : 'automation.wakeDisabledHint',
        )}
      </p>
    </PolicyForm>
  );
}
export function ServerWakeAccessSettings({ serverId }: { serverId: string }) {
  const t = useT();
  const policy = useQuery({
    queryKey: ['auto-wake-policy', serverId],
    queryFn: () => api<WakePolicy | null>(`${platformPath(serverId)}/auto-wake-policy`),
  });
  if (!policy.data) return policy.error ? <ErrorNotice error={policy.error} /> : null;
  return (
    <section className="sleep-wake-admin-setting" aria-label={t('automation.wakeAccess')}>
      <h4>{t('automation.wakeAccess')}</h4>
      {policy.error && <ErrorNotice error={policy.error} />}
      <ServerWakeAccessEditor
        key={JSON.stringify([policy.data.ownerUserAccessOverride, policy.data.inheritedUserAccess])}
        value={policy.data}
        onSubmit={async (data) => {
          await api(`${platformPath(serverId)}/auto-wake-policy`, {
            method: 'PUT',
            body: {
              overrideEnabled: policy.data?.overrideEnabled,
              userAccess: readAccess(data, 'access'),
            },
          });
          await policy.refetch();
        }}
      />
    </section>
  );
}
function ServerWakeAccessEditor({
  value,
  onSubmit,
}: {
  value: WakePolicy;
  onSubmit: (data: FormData) => Promise<unknown>;
}) {
  const initialAccess = value.ownerUserAccessOverride ?? null;
  const [access, setAccess] = useState<WakeAccess | null>(initialAccess);
  return (
    <PolicyForm
      dirty={access !== initialAccess}
      onSubmit={onSubmit}
      onCancel={() => setAccess(initialAccess)}
    >
      <WakeAccessField
        name="access"
        value={initialAccess}
        inherited={value.inheritedUserAccess ?? 'editable'}
        onChange={setAccess}
      />
    </PolicyForm>
  );
}
interface IntegrationWakePolicy {
  gameEnabled: boolean | null;
  runtimeEnabled: Record<string, boolean>;
  userAccess: WakeAccess | null;
  runtimeUserAccess: Record<string, WakeAccess>;
  effectiveGameEnabled: boolean;
  effectiveUserAccess: WakeAccess;
  inheritedGameEnabled: boolean;
  inheritedUserAccess: WakeAccess;
  runtimes: Array<{ id: string; name: string; nameKey?: string }>;
  locked: boolean;
}
export function IntegrationWakeSettings({
  gameId,
  initialRuntimeId,
}: {
  gameId: string;
  initialRuntimeId?: string;
}) {
  const t = useT();
  const policy = useQuery({
    queryKey: ['integration-auto-wake', gameId],
    queryFn: () =>
      api<IntegrationWakePolicy>(
        `/v1/owner/integrations/${encodeURIComponent(gameId)}/auto-wake-policy`,
      ),
  });
  const [draft, setDraft] = useState<boolean | null | undefined>();
  const [access, setAccess] = useState<WakeAccess | null | undefined>();
  if (policy.error) return <ErrorNotice error={policy.error} />;
  if (!policy.data)
    return (
      <div
        role="status"
        className="automation-skeleton"
        aria-busy="true"
        aria-label={t('web.loading')}
      />
    );
  const value = policy.data;
  return (
    <section className="automation-policy automation-integration-wake">
      <h3>{t('automation.autoWake')}</h3>
      {value.locked && <Notice>{t('sleepTiming.locked')}</Notice>}
      <ActionForm
        disabled={value.locked}
        key={JSON.stringify(value)}
        onSubmit={async (data) => {
          const runtimeEnabled: Record<string, boolean> = {};
          const runtimeUserAccess: Record<string, unknown> = {};
          for (const runtime of value.runtimes) {
            const enabled = readEnabled(data, `wake-${runtime.id}`);
            if (enabled !== null) runtimeEnabled[runtime.id] = enabled;
            const permission = readAccess(data, `access-${runtime.id}`);
            if (permission !== null) runtimeUserAccess[runtime.id] = permission;
          }
          await api(`/v1/owner/integrations/${encodeURIComponent(gameId)}/auto-wake-policy`, {
            method: 'PUT',
            body: {
              gameEnabled: readEnabled(data, 'wake-game'),
              userAccess: readAccess(data, 'wake-access'),
              runtimeEnabled,
              runtimeUserAccess,
            },
          });
          await policy.refetch();
          setDraft(undefined);
          setAccess(undefined);
        }}
      >
        <WakeValue
          name="wake-game"
          value={value.gameEnabled}
          inherited={value.inheritedGameEnabled}
          onChange={setDraft}
        />
        <WakeAccessField
          name="wake-access"
          value={value.userAccess}
          inherited={value.inheritedUserAccess}
          onChange={setAccess}
        />
        {value.runtimes.map((runtime) => (
          <details key={runtime.id} open={runtime.id === initialRuntimeId || undefined}>
            <summary>{runtime.nameKey ? t(runtime.nameKey) : runtime.name}</summary>
            <WakeValue
              name={`wake-${runtime.id}`}
              value={value.runtimeEnabled[runtime.id] ?? null}
              inherited={
                draft === undefined
                  ? value.effectiveGameEnabled
                  : (draft ?? value.inheritedGameEnabled)
              }
            />
            <WakeAccessField
              name={`access-${runtime.id}`}
              value={value.runtimeUserAccess[runtime.id] ?? null}
              inherited={
                access === undefined
                  ? value.effectiveUserAccess
                  : (access ?? value.inheritedUserAccess)
              }
            />
          </details>
        ))}
      </ActionForm>
    </section>
  );
}
export function GlobalWakeSettings({
  values,
  lockedKeys,
  editable,
  onSaved,
}: {
  values: Record<string, unknown>;
  lockedKeys: string[];
  editable: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const t = useT();
  const enabledLocked = lockedKeys.includes('defaultAutoWakeEnabled'),
    accessLocked = lockedKeys.includes('autoWakeUserAccess');
  return (
    <section className="automation-policy">
      {(enabledLocked || accessLocked) && <Notice>{t('sleepTiming.locked')}</Notice>}
      <ActionForm
        disabled={!editable || (enabledLocked && accessLocked)}
        key={JSON.stringify([values.defaultAutoWakeEnabled, values.autoWakeUserAccess])}
        onSubmit={async (data) => {
          await api('/v1/owner/settings', {
            method: 'PATCH',
            body: {
              ...(!enabledLocked
                ? { defaultAutoWakeEnabled: readEnabled(data, 'wake-global') }
                : {}),
              ...(!accessLocked
                ? { autoWakeUserAccess: readAccess(data, 'wake-global-access') }
                : {}),
            },
          });
          await onSaved();
        }}
      >
        <WakeValue
          name="wake-global"
          value={values.defaultAutoWakeEnabled !== false}
          disabled={enabledLocked}
        />
        <WakeAccessField
          name="wake-global-access"
          value={(values.autoWakeUserAccess ?? 'editable') as WakeAccess}
          disabled={accessLocked}
        />
      </ActionForm>
    </section>
  );
}
