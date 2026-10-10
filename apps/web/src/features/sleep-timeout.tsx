import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { ActionForm, ErrorNotice, Input, Loading, Notice, Select } from '../components/ui.js';

export interface IntegrationSleepPolicy {
  gameId: string;
  gameTimeoutSeconds: number | null;
  runtimeTimeouts: Record<string, number>;
  effectiveGameSeconds: number;
  userAccess: SleepAccess | null;
  runtimeUserAccess: Record<string, SleepAccess>;
  effectiveUserAccess: SleepAccess;
  inheritedGameSeconds?: number;
  inheritedUserAccess?: SleepAccess;
  runtimes: Array<{ id: string; name: string; nameKey?: string }>;
  locked: boolean;
}

/** Null means inherit; -1 explicitly disables sleep. */
export function readSleepTimeout(data: FormData, name: string): number | null {
  if (data.get(`${name}Mode`) === 'inherit') return null;
  const minutes = Number(data.get(name));
  const seconds = minutes === -1 ? -1 : Math.round(minutes * 60);
  if (
    !Number.isFinite(minutes) ||
    (minutes !== -1 && (minutes <= 0 || seconds < 1 || seconds > 604800))
  )
    throw new ApiError('validation_failed', 'sleepTiming.invalid');
  return seconds;
}

export function SleepTimeoutField({
  name,
  value,
  inheritedSeconds,
  disabled = false,
  allowInherit = true,
  maximumSeconds = 604800,
  allowDisable = true,
  onChange,
}: {
  name: string;
  value: number | null;
  inheritedSeconds: number;
  disabled?: boolean;
  allowInherit?: boolean;
  maximumSeconds?: number;
  allowDisable?: boolean;
  onChange?: (seconds: number | null) => void;
}) {
  const t = useT();
  const format = useFormat();
  const [mode, setMode] = useState(allowInherit && value === null ? 'inherit' : 'override');
  const [minutes, setMinutes] = useState(
    value === null || value === -1
      ? allowDisable
        ? -1
        : Math.min(inheritedSeconds, maximumSeconds) / 60
      : value / 60,
  );
  const inherited =
    inheritedSeconds === -1
      ? t('sleepTiming.disabled')
      : t('sleepTiming.minutes', { minutes: format.number(inheritedSeconds / 60, 3) });
  return (
    <>
      {allowInherit ? (
        <Select
          name={`${name}Mode`}
          label={t('sleepTiming.setting')}
          value={mode}
          disabled={disabled}
          onChange={(event) => {
            setMode(event.target.value);
            onChange?.(
              event.target.value === 'inherit'
                ? null
                : minutes === -1
                  ? -1
                  : Math.round(minutes * 60),
            );
          }}
        >
          <option value="inherit">{t('sleepTiming.inherit', { value: inherited })}</option>
          <option value="override">{t('sleepTiming.override')}</option>
        </Select>
      ) : (
        <input type="hidden" name={`${name}Mode`} value="override" />
      )}
      {mode === 'override' && (
        <Input
          name={name}
          label={t('sleepTiming.timeout')}
          hint={t(allowDisable ? 'sleepTiming.disabledHint' : 'sleepTiming.shortenHint')}
          type="number"
          min={allowDisable ? -1 : 1 / 60}
          max={maximumSeconds / 60}
          step="any"
          required
          disabled={disabled}
          value={Number.isNaN(minutes) ? '' : minutes}
          onChange={(event) => {
            const number = event.currentTarget.valueAsNumber;
            setMinutes(number);
            if (number === -1 && allowDisable) onChange?.(-1);
            else if (number > 0 && number * 60 <= maximumSeconds)
              onChange?.(Math.round(number * 60));
            event.currentTarget.setCustomValidity(
              !(number === -1 && allowDisable) && !(number > 0 && number * 60 <= maximumSeconds)
                ? t('sleepTiming.invalid')
                : '',
            );
          }}
        />
      )}
    </>
  );
}

export function IntegrationSleepSettings({ gameId }: { gameId: string }) {
  const t = useT();
  const [gameDraft, setGameDraft] = useState<number | null | undefined>();
  const [accessDraft, setAccessDraft] = useState<SleepAccess | null | undefined>();
  const policy = useQuery({
    queryKey: ['integration-sleep-policy', gameId],
    queryFn: () =>
      api<IntegrationSleepPolicy>(
        `/v1/owner/integrations/${encodeURIComponent(gameId)}/sleep-policy`,
      ),
  });
  return (
    <details data-testid={`sleep-settings-${gameId}`}>
      <summary>{t('sleepTiming.title')}</summary>
      {policy.isPending ? (
        <Loading />
      ) : policy.error ? (
        <ErrorNotice error={policy.error} />
      ) : (
        <>
          {policy.data.locked ? <Notice>{t('sleepTiming.locked')}</Notice> : null}
          <fieldset disabled={policy.data.locked}>
            <ActionForm
              key={JSON.stringify(policy.data)}
              onSubmit={async (data) => {
                const runtimeTimeouts: Record<string, number> = {};
                const runtimeUserAccess: Record<string, SleepAccess> = {};
                for (const runtime of policy.data.runtimes) {
                  const value = readSleepTimeout(data, `sleepRuntime-${runtime.id}`);
                  if (value !== null) runtimeTimeouts[runtime.id] = value;
                  const access = readSleepAccess(data, `sleepRuntimeAccess-${runtime.id}`);
                  if (access !== null) runtimeUserAccess[runtime.id] = access;
                }
                await api(`/v1/owner/integrations/${encodeURIComponent(gameId)}/sleep-policy`, {
                  method: 'PUT',
                  body: {
                    gameTimeoutSeconds: readSleepTimeout(data, 'sleepGame'),
                    runtimeTimeouts,
                    userAccess: readSleepAccess(data, 'sleepGameAccess'),
                    runtimeUserAccess,
                  },
                });
                await policy.refetch();
                setGameDraft(undefined);
                setAccessDraft(undefined);
              }}
            >
              <fieldset disabled={policy.data.locked}>
                <legend>{t('sleepTiming.game')}</legend>
                <SleepTimeoutField
                  name="sleepGame"
                  value={policy.data.gameTimeoutSeconds}
                  inheritedSeconds={policy.data.inheritedGameSeconds ?? -1}
                  onChange={setGameDraft}
                />
                <SleepAccessField
                  name="sleepGameAccess"
                  onChange={setAccessDraft}
                  value={policy.data.userAccess}
                  inherited={policy.data.inheritedUserAccess ?? 'hidden'}
                />
                <p className="muted">{t('sleepTiming.capability')}</p>
                {policy.data.runtimes.map((runtime) => (
                  <details key={runtime.id}>
                    <summary>{runtime.nameKey ? t(runtime.nameKey) : runtime.name}</summary>
                    <SleepTimeoutField
                      name={`sleepRuntime-${runtime.id}`}
                      value={policy.data.runtimeTimeouts[runtime.id] ?? null}
                      inheritedSeconds={
                        gameDraft === undefined
                          ? policy.data.effectiveGameSeconds
                          : (gameDraft ?? policy.data.inheritedGameSeconds ?? -1)
                      }
                    />
                    <SleepAccessField
                      name={`sleepRuntimeAccess-${runtime.id}`}
                      value={policy.data.runtimeUserAccess[runtime.id] ?? null}
                      inherited={
                        accessDraft === undefined
                          ? policy.data.effectiveUserAccess
                          : (accessDraft ?? policy.data.inheritedUserAccess ?? 'hidden')
                      }
                    />
                  </details>
                ))}
              </fieldset>
            </ActionForm>
          </fieldset>
        </>
      )}
    </details>
  );
}

export type SleepAccess = 'hidden' | 'editable' | 'shorten-only';
export function SleepAccessField({
  name,
  value,
  inherited,
  disabled = false,
  onChange,
}: {
  name: string;
  value: SleepAccess | null;
  inherited?: SleepAccess;
  disabled?: boolean;
  onChange?: (access: SleepAccess | null) => void;
}) {
  const t = useT();
  return (
    <Select
      name={name}
      label={t('sleepTiming.userAccess')}
      defaultValue={value ?? 'inherit'}
      disabled={disabled}
      onChange={(event) =>
        onChange?.(event.target.value === 'inherit' ? null : (event.target.value as SleepAccess))
      }
    >
      {inherited && (
        <option value="inherit">
          {t('sleepTiming.inherit', { value: t(`sleepTiming.access.${inherited}`) })}
        </option>
      )}
      {(['hidden', 'editable', 'shorten-only'] as const).map((access) => (
        <option key={access} value={access}>
          {t(`sleepTiming.access.${access}`)}
        </option>
      ))}
    </Select>
  );
}
export function readSleepAccess(data: FormData, name: string): SleepAccess | null {
  const value = data.get(name);
  if (value === 'inherit') return null;
  if (value === 'hidden' || value === 'editable' || value === 'shorten-only') return value;
  throw new ApiError('validation_failed', 'errors.validation_failed');
}
export function GlobalSleepSettings({
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
  const timeoutLocked = lockedKeys.includes('defaultIdleTimeoutSeconds');
  const accessLocked = lockedKeys.includes('idleTimeoutUserAccess');
  const locked = timeoutLocked && accessLocked;
  return (
    <fieldset disabled={!editable || locked}>
      {(timeoutLocked || accessLocked) && <Notice>{t('sleepTiming.locked')}</Notice>}
      <ActionForm
        key={JSON.stringify([values.defaultIdleTimeoutSeconds, values.idleTimeoutUserAccess])}
        onSubmit={async (data) => {
          await api('/v1/owner/settings', {
            method: 'PATCH',
            body: {
              ...(!timeoutLocked
                ? { defaultIdleTimeoutSeconds: readSleepTimeout(data, 'sleepGlobal') }
                : {}),
              ...(!accessLocked
                ? { idleTimeoutUserAccess: readSleepAccess(data, 'sleepGlobalAccess') }
                : {}),
            },
          });
          await onSaved();
        }}
      >
        <SleepTimeoutField
          name="sleepGlobal"
          disabled={timeoutLocked}
          value={
            typeof values.defaultIdleTimeoutSeconds === 'number'
              ? values.defaultIdleTimeoutSeconds
              : -1
          }
          inheritedSeconds={-1}
          allowInherit={false}
        />
        <SleepAccessField
          name="sleepGlobalAccess"
          disabled={accessLocked}
          value={(values.idleTimeoutUserAccess ?? 'hidden') as SleepAccess}
        />
      </ActionForm>
    </fieldset>
  );
}
