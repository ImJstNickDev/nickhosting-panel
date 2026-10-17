import { type ReactNode, useId, useRef, useState } from 'react';
import { useFormat, useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import { ActionForm, ErrorNotice, Input } from '../components/ui.js';
import type { SleepPolicy } from './service-contracts.js';
import { type SleepAccess, SleepAccessField } from './sleep-timeout.js';

export function PolicyHeading({
  kind,
  title,
  value,
  source,
}: {
  kind: 'sleep' | 'wake';
  title: string;
  value: string;
  source: string;
}) {
  const t = useT();
  return (
    <header className="sleep-wake-heading">
      <span className="sleep-wake-icon" aria-hidden="true">
        <svg
          aria-hidden="true"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path
            d={
              kind === 'sleep'
                ? 'M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z'
                : 'M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'
            }
          />
        </svg>
      </span>
      <div>
        <h3>{title}</h3>
        <p className="sleep-wake-current">
          <strong>{value}</strong>
          <span className="sleep-wake-source">
            {t('automation.fromSource', { source: t(`sleepTiming.source.${source}`) })}
          </span>
        </p>
      </div>
    </header>
  );
}
export function PolicyChoices({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  disabled?: boolean;
  label: string;
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="sleep-wake-choices" aria-label={label} disabled={disabled}>
      {options.map((option) => (
        <button
          type="button"
          className="sleep-wake-choice"
          key={option.value}
          aria-pressed={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
export function PolicyForm({
  dirty,
  onSubmit,
  onCancel,
  children,
  disabled = false,
}: {
  disabled?: boolean;
  dirty: boolean;
  onCancel: () => void;
  onSubmit: (data: FormData) => Promise<unknown>;
  children: ReactNode;
}) {
  const t = useT();
  const [reset, setReset] = useState(0);
  return (
    <ActionForm
      key={reset}
      className={`form sleep-wake-form${dirty ? ' is-dirty' : ''}`}
      submitDisabled={!dirty}
      disabled={disabled}
      success={false}
      onSubmit={onSubmit}
      footerStart={
        <Tooltip content={t('automation.resetValue')}>
          <button
            type="button"
            className="automation-icon"
            aria-label={t('automation.resetValue')}
            onClick={() => {
              onCancel();
              setReset((value) => value + 1);
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
            </svg>
          </button>
        </Tooltip>
      }
    >
      {children}
    </ActionForm>
  );
}
// Mode changes are discrete writes; keep selection truthful until the write completes.
export function useImmediatePolicySave(onSubmit: (data: FormData) => Promise<unknown>) {
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  async function save(data: FormData) {
    if (active.current) return false;
    active.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onSubmit(data);
      return true;
    } catch (failure) {
      setError(failure);
      return false;
    } finally {
      active.current = false;
      setPending(false);
    }
  }
  return { pending, error, save, clearError: () => setError(undefined) };
}
export function ServerSleepEditor({
  sleep,
  owner,
  disabled = false,
  onSubmit,
}: {
  disabled?: boolean;
  sleep: NonNullable<SleepPolicy['idleTimeout']>;
  owner: boolean;
  onSubmit: (data: FormData) => Promise<unknown>;
}) {
  const t = useT(),
    format = useFormat(),
    hintId = useId();
  const initialMode =
    sleep.overrideSeconds === null
      ? 'inherit'
      : sleep.overrideSeconds === -1
        ? 'disabled'
        : 'custom';
  const [mode, setMode] = useState(initialMode);
  const maximum =
    !owner && sleep.userAccess === 'shorten-only' && sleep.ownerBaselineSeconds !== -1
      ? sleep.ownerBaselineSeconds
      : 604800;
  const initialMinutes =
    Math.min(
      sleep.overrideSeconds && sleep.overrideSeconds > 0
        ? sleep.overrideSeconds
        : sleep.inheritedSeconds > 0
          ? sleep.inheritedSeconds
          : 60,
      maximum,
    ) / 60;
  const [minutes, setMinutes] = useState(String(initialMinutes));
  const dirty = mode === 'custom' && Number(minutes) !== initialMinutes;
  const immediate = useImmediatePolicySave(onSubmit);
  const inherited =
    sleep.inheritedSeconds === -1
      ? t('sleepTiming.disabled')
      : t('sleepTiming.minutes', { minutes: format.number(sleep.inheritedSeconds / 60, 3) });
  return (
    <PolicyForm
      dirty={dirty}
      disabled={immediate.pending || disabled}
      onSubmit={(data) => {
        immediate.clearError();
        return onSubmit(data);
      }}
      onCancel={() => {
        immediate.clearError();
        setMode(initialMode);
        setMinutes(String(initialMinutes));
      }}
    >
      {Boolean(immediate.error) && <ErrorNotice error={immediate.error} />}
      <input
        type="hidden"
        name="idleMinutesMode"
        value={mode === 'inherit' ? 'inherit' : 'override'}
      />
      <PolicyChoices
        label={t('sleepTiming.setting')}
        value={mode}
        onChange={async (next) => {
          if (next === mode) return;
          const data = new FormData();
          data.set('idleMinutesMode', next === 'inherit' ? 'inherit' : 'override');
          data.set('idleMinutes', next === 'custom' ? String(initialMinutes) : '-1');
          if (await immediate.save(data)) {
            setMode(next);
            setMinutes(String(initialMinutes));
          }
        }}
        options={[
          { value: 'inherit', label: t('automation.inherit') },
          { value: 'custom', label: t('automation.custom') },
          {
            value: 'disabled',
            label: t('web.disabled'),
            disabled:
              !owner && sleep.userAccess === 'shorten-only' && sleep.ownerBaselineSeconds !== -1,
          },
        ]}
      />
      {mode === 'custom' ? (
        <div className="sleep-wake-time">
          <Input
            name="idleMinutes"
            type="number"
            label={t('automation.idleMinutes')}
            value={minutes}
            // Use an integral native step base; 1/60 offsets Firefox's arrows.
            min={0}
            max={maximum / 60}
            step="any"
            required
            onChange={(event) => {
              const input = event.currentTarget;
              input.setCustomValidity(
                input.value && Math.round(Number(input.value) * 60) < 1
                  ? t('automation.positiveIdleMinutes')
                  : '',
              );
              setMinutes(input.value);
            }}
            aria-describedby={!owner && sleep.userAccess === 'shorten-only' ? hintId : undefined}
          />
          {!owner && sleep.userAccess === 'shorten-only' && (
            <p id={hintId} className="sleep-wake-hint">
              {t('sleepTiming.shortenHint')}
            </p>
          )}
        </div>
      ) : (
        <input type="hidden" name="idleMinutes" value={-1} />
      )}
      {mode === 'inherit' && (
        <p className="sleep-wake-hint">{t('automation.inheritedValue', { value: inherited })}</p>
      )}
    </PolicyForm>
  );
}

export function ServerSleepAccessEditor({
  sleep,
  disabled = false,
  onSubmit,
}: {
  disabled?: boolean;
  sleep: Extract<NonNullable<SleepPolicy['idleTimeout']>, { ownerUserAccessOverride: unknown }>;
  onSubmit: (data: FormData) => Promise<unknown>;
}) {
  const initialAccess = sleep.ownerUserAccessOverride ?? null;
  const [access, setAccess] = useState<SleepAccess | null>(initialAccess);
  return (
    <PolicyForm
      dirty={access !== initialAccess}
      disabled={disabled}
      onSubmit={onSubmit}
      onCancel={() => setAccess(initialAccess)}
    >
      <SleepAccessField
        name="sleepAccess"
        value={initialAccess}
        inherited={sleep.inheritedUserAccess ?? 'hidden'}
        onChange={setAccess}
      />
    </PolicyForm>
  );
}
