import { type TrustedGameUiModule, type UiOption, uiOptionSchema } from '@nickhosting/game-sdk/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useT } from '../app/i18n.js';
import { Check, Empty, ErrorNotice, Loading } from '../components/ui.js';
import { creationCatalogQuery } from './creation-catalog.js';
import { gameUiClient } from './integrations.js';

export function VersionList({
  module,
  fieldId,
  versionFilter = true,
  presentation = 'list',
  values,
  value,
  onChange,
  onChoices,
}: {
  module: TrustedGameUiModule;
  fieldId: string;
  versionFilter?: boolean;
  presentation?: 'list' | 'cards';
  values: Record<string, unknown>;
  value: unknown;
  onChange(value: string): void;
  onChoices(options: UiOption[]): void;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  const field = module.descriptor.creation.fields.find((entry) => entry.id === fieldId);
  const artwork = module.descriptor.artwork
    ? module.assets?.[module.descriptor.artwork.assetId]
    : undefined;
  const source = field?.type === 'choice' ? field.source : undefined;
  const dependencies = Object.fromEntries((source?.dependsOn ?? []).map((id) => [id, values[id]]));
  const shared = Boolean(
    source &&
      module.creationCatalog?.handlers.includes(source.handler) &&
      module.creationCatalog.applies?.(source.handler, values) !== false,
  );
  const catalog = useQuery({ ...creationCatalogQuery(module), enabled: shared });
  const loadedOptions = useQuery({
    enabled: !shared,
    staleTime: 60_000,
    queryKey: ['creation', 'installer-choices', module.descriptor.gameId, fieldId, dependencies],
    queryFn: async ({ signal }) =>
      z
        .array(uiOptionSchema)
        .max(10000)
        .parse(
          source
            ? await module.handlers[source.handler]?.(gameUiClient, { values, signal })
            : field?.type === 'choice'
              ? field.options
              : [],
        ),
  });
  const sharedOptions = useMemo(
    () =>
      catalog.data === undefined || !shared
        ? undefined
        : z
            .array(uiOptionSchema)
            .max(10000)
            .parse(module.creationCatalog?.options(catalog.data, source?.handler ?? '', values)),
    [catalog.data, shared, module, source?.handler, values],
  );
  const options = shared ? { ...catalog, data: sharedOptions } : loadedOptions;
  useEffect(() => {
    if (options.data) onChoices(options.data);
  }, [options.data, onChoices]);
  const visible =
    options.data?.filter(
      (o) => !versionFilter || all || !o.releaseType || o.releaseType === 'release',
    ) ?? [];
  return (
    <>
      {versionFilter && (
        <Check
          label={t('gameUi.showAllVersions')}
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
      )}
      {options.isPending ? (
        <Loading />
      ) : options.error ? (
        <ErrorNotice error={options.error} retry={() => void options.refetch()} />
      ) : !visible.length ? (
        <Empty
          text={t(
            versionFilter && !all && options.data?.length
              ? 'gameUi.noStableVersions'
              : 'gameUi.noOptions',
          )}
        />
      ) : (
        <div
          className={presentation === 'cards' ? 'installer-choice-cards' : 'installer-versions'}
          role="radiogroup"
          aria-label={t(field?.labelKey ?? 'gameUi.version')}
        >
          {visible.map((o) => (
            <label
              key={o.value}
              className={presentation === 'cards' ? 'installer-choice-card' : 'installer-version'}
            >
              {presentation === 'cards' && artwork && (
                <img
                  className="installer-choice-art"
                  src={artwork}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                />
              )}
              <input
                className="installer-choice-input"
                type="radio"
                name={`server-${fieldId}`}
                value={o.value}
                checked={value === o.value}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
              />
              {presentation === 'list' && (
                <span className="installer-choice-check" aria-hidden="true">
                  ✓
                </span>
              )}
              <span className={presentation === 'cards' ? 'installer-choice-title' : undefined}>
                {o.label ?? t(o.labelKey ?? '')}
              </span>
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
      <div className="player-error-slot">
        {error !== undefined && <ErrorNotice error={error} />}
      </div>
      <label htmlFor={id}>{t('gameUi.playerName')}</label>
      <div className="player-entry">
        {avatar(preview)}
        <input
          id={id}
          type="text"
          value={draft}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          maxLength={16}
          readOnly={busy}
          aria-busy={busy}
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
