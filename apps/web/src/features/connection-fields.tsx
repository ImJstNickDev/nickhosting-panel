import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef } from 'react';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import { ErrorNotice, Loading } from '../components/ui.js';
import './connection.css';

import type { ConnectionChoice, ConnectionOptions } from './connection.api.js';
import type { ConnectionAvailabilityState } from './connection-availability.js';

export type { ConnectionChoice, ConnectionOptions } from './connection.api.js';
export function useConnectionOptions(gameId: string) {
  return useQuery({
    queryKey: ['connection-options', 'game', gameId],
    queryFn: ({ signal }) =>
      api<ConnectionOptions>(`/v1/games/${encodeURIComponent(gameId)}/connection-options`, {
        signal,
      }),
    enabled: Boolean(gameId),
    staleTime: 60_000,
  });
}
export function ConnectionFields({
  options,
  value,
  onChange,
  focusOnEntry = false,
  descriptionId,
  invalid,
  generate,
  generating = false,
}: {
  options: ConnectionOptions;
  value: ConnectionChoice;
  onChange: (choice: ConnectionChoice) => void;
  focusOnEntry?: boolean;
  descriptionId?: string;
  invalid?: boolean;
  generate?: () => void;
  generating?: boolean;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnEntry) input.current?.focus({ preventScroll: true });
  }, [focusOnEntry]);
  if (!options.configured) return <p className="muted">{t('connection.unconfigured')}</p>;
  if (!options.customizable)
    return options.defaultHostname ? <code>{options.defaultHostname}</code> : null;
  const domainId = value.domainId ?? options.defaultDomainId ?? options.domains[0]?.id;
  const domain = options.domains.find((entry) => entry.id === domainId);
  const defaultLabel =
    options.mode === 'shared-host' &&
    domain &&
    options.defaultHostname?.endsWith(`.${domain.hostname}`)
      ? options.defaultHostname.slice(0, -(domain.hostname.length + 1))
      : undefined;
  return (
    <div className="connection-fields">
      <div className="connection-label-domain" data-invalid={invalid || undefined}>
        <input
          aria-label={t('service.subdomain')}
          aria-describedby={descriptionId}
          aria-invalid={invalid || undefined}
          ref={input}
          value={value.subdomain ?? ''}
          placeholder={generate ? '' : (defaultLabel ?? t('connection.automatic'))}
          maxLength={63}
          pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
          autoComplete="off"
          autoCapitalize="none"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          spellCheck={false}
          onChange={(event) =>
            onChange({ ...value, subdomain: event.target.value.toLowerCase() || undefined })
          }
        />
        {options.domains.length > 1 ? (
          <select
            aria-label={t('connection.domain')}
            value={domainId}
            onChange={(event) => onChange({ ...value, domainId: event.target.value })}
          >
            {options.domains.map((entry) => (
              <option key={entry.id} value={entry.id}>
                .{entry.hostname}
              </option>
            ))}
          </select>
        ) : domain ? (
          <span className="connection-domain-suffix">.{domain.hostname}</span>
        ) : null}
        {generate && (
          <Tooltip content={t('connection.generate')}>
            <button
              type="button"
              className="connection-generate"
              aria-label={t('connection.generate')}
              disabled={generating}
              onClick={generate}
            >
              <svg
                viewBox="0 0 24 24"
                width="19"
                height="19"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className={generating ? 'connection-spinner' : undefined}
              >
                <path d="M20 7v5h-5M4 17v-5h5" />
                <path d="M6.2 6.2A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.8" />
              </svg>
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
export function CreationConnection({
  options,
  value,
  onChange,
  availability,
  retry,
  generate,
  generating,
}: {
  options: ReturnType<typeof useConnectionOptions>;
  availability: ConnectionAvailabilityState;
  retry?: () => void;
  generate?: () => void;
  generating?: boolean;
  value: ConnectionChoice;
  onChange: (choice: ConnectionChoice) => void;
}) {
  const t = useT();
  const statusId = useId();
  if (options.isPending) return <Loading />;
  if (options.error)
    return <ErrorNotice error={options.error} retry={() => void options.refetch()} />;
  if (!options.data) return null;
  const message = availability === 'unchecked' ? 'checking' : availability;
  return (
    <div className="creation-connection">
      <ConnectionFields
        options={options.data}
        value={value}
        onChange={onChange}
        focusOnEntry
        descriptionId={statusId}
        invalid={['invalid', 'prohibited', 'taken'].includes(message)}
        generate={generate}
        generating={generating}
      />
      <div
        className="connection-availability"
        id={statusId}
        role="status"
        aria-live="polite"
        data-state={message}
      >
        {message !== 'automatic' && <span>{t(`connection.availability.${message}`)}</span>}
        {message === 'unavailable' && retry && (
          <button type="button" className="connection-retry" onClick={retry}>
            {t('web.retry')}
          </button>
        )}
      </div>
    </div>
  );
}
