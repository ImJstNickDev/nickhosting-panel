import { type TrustedGameUiModule, type UiOption, uiOptionSchema } from '@nickhosting/game-sdk/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { useT } from '../app/i18n.js';
import { Check, Empty, ErrorNotice, Loading } from '../components/ui.js';
import { gameUiClient } from './integrations.js';

export function VersionList({
  module,
  values,
  value,
  onChange,
  onChoices,
}: {
  module: TrustedGameUiModule;
  values: Record<string, unknown>;
  value: unknown;
  onChange(value: string): void;
  onChoices(options: UiOption[]): void;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  const options = useQuery({
    queryKey: ['installer-choices', module.descriptor.gameId],
    queryFn: async ({ signal }) =>
      z
        .array(uiOptionSchema)
        .max(10000)
        .parse(
          await module.handlers[module.descriptor.creation.choicesHandler]?.(gameUiClient, {
            values,
            signal,
          }),
        ),
  });
  useEffect(() => {
    if (options.data) onChoices(options.data);
  }, [options.data, onChoices]);
  const visible =
    options.data?.filter((o) => all || !o.releaseType || o.releaseType === 'release') ?? [];
  return (
    <>
      <Check
        label={t('gameUi.showAllVersions')}
        checked={all}
        onChange={(e) => setAll(e.target.checked)}
      />
      {options.isPending ? (
        <Loading />
      ) : options.error ? (
        <ErrorNotice error={options.error} retry={() => void options.refetch()} />
      ) : !visible.length ? (
        <Empty text={t('gameUi.noOptions')} />
      ) : (
        <div className="installer-versions" role="radiogroup" aria-label={t('gameUi.version')}>
          {visible.map((o) => (
            <label key={o.value} className="installer-version">
              <input
                type="radio"
                name="server-version"
                value={o.value}
                checked={value === o.value}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
              />
              <span>{o.label ?? t(o.labelKey ?? '')}</span>
            </label>
          ))}
        </div>
      )}
    </>
  );
}

export function PlayerList({
  module,
  handler,
  names,
  onChange,
  onPendingChange,
}: {
  module: TrustedGameUiModule;
  handler: string;
  names: string[];
  onChange(names: string[]): void;
  onPendingChange(pending: boolean): void;
}) {
  const t = useT(),
    id = useId();
  const [draft, setDraft] = useState(''),
    [preview, setPreview] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  useEffect(() => {
    const timer = setTimeout(
      () => setPreview(/^[A-Za-z0-9_]{3,16}$/.test(draft) ? draft : ''),
      350,
    );
    return () => clearTimeout(timer);
  }, [draft]);
  const request = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      request.current?.abort();
      onPendingChange(false);
    },
    [onPendingChange],
  );
  const appearance = module.playerAppearance;
  async function add() {
    if (request.current || busy || names.length >= 1000 || !/^[A-Za-z0-9_]{3,16}$/.test(draft))
      return;
    const controller = new AbortController();
    request.current = controller;
    onPendingChange(true);
    setBusy(true);
    setError(undefined);
    try {
      const found = z
        .object({ name: z.string().regex(/^[A-Za-z0-9_]{3,16}$/), uuid: z.string() })
        .parse(
          await module.handlers[handler]?.(gameUiClient, {
            values: { name: draft },
            signal: controller.signal,
          }),
        );
      if (controller.signal.aborted) return;
      if (!names.some((n) => n.toLowerCase() === found.name.toLowerCase()))
        onChange([...names, found.name]);
      setDraft('');
    } catch (e) {
      if (!controller.signal.aborted) setError(e);
    } finally {
      request.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        onPendingChange(false);
      }
    }
  }
  const avatar = (name: string) =>
    appearance && (
      <img
        className="player-avatar"
        alt=""
        width={40}
        height={40}
        referrerPolicy="no-referrer"
        src={name ? appearance.avatarUrl(name) : appearance.fallback}
        onError={(e) => {
          if (e.currentTarget.src !== appearance.fallback)
            e.currentTarget.src = appearance.fallback;
        }}
      />
    );
  return (
    <div className="installer-players">
      {error !== undefined && <ErrorNotice error={error} />}
      <label htmlFor={id}>{t('gameUi.playerName')}</label>
      <div className="player-entry">
        {avatar(preview)}
        <input
          id={id}
          value={draft}
          autoComplete="off"
          maxLength={16}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button
          type="button"
          disabled={busy || !/^[A-Za-z0-9_]{3,16}$/.test(draft) || names.length >= 1000}
          onClick={() => void add()}
        >
          {t(busy ? 'web.loading' : 'gameUi.addPlayer')}
        </button>
      </div>
      <ul className="player-list" aria-live="polite">
        {names.map((name) => (
          <li key={name.toLowerCase()}>
            {avatar(name)}
            <span>{name}</span>
            <button
              type="button"
              className="secondary player-remove"
              disabled={busy}
              aria-label={t('gameUi.removePlayer', { name })}
              onClick={() => onChange(names.filter((n) => n !== name))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
