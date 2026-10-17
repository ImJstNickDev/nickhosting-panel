import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ErrorNotice, Input, Loading, Select } from '../components/ui.js';
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
}: {
  options: ConnectionOptions;
  value: ConnectionChoice;
  onChange: (choice: ConnectionChoice) => void;
  focusOnEntry?: boolean;
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
  return (
    <div className="connection-fields">
      <div className="connection-label-domain">
        <Input
          label={t('service.subdomain')}
          ref={input}
          value={value.subdomain ?? ''}
          placeholder={t('connection.automatic')}
          maxLength={63}
          pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) =>
            onChange({ ...value, subdomain: event.target.value.toLowerCase() || undefined })
          }
        />
        {options.domains.length > 1 ? (
          <Select
            label={t('connection.domain')}
            value={domainId}
            onChange={(event) => onChange({ ...value, domainId: event.target.value })}
          >
            {options.domains.map((entry) => (
              <option key={entry.id} value={entry.id}>
                .{entry.hostname}
              </option>
            ))}
          </Select>
        ) : domain ? (
          <span className="connection-domain-suffix">.{domain.hostname}</span>
        ) : null}
      </div>
    </div>
  );
}
export function CreationConnection({
  options,
  value,
  onChange,
  availability,
}: {
  options: ReturnType<typeof useConnectionOptions>;
  availability: ConnectionAvailabilityState;
  value: ConnectionChoice;
  onChange: (choice: ConnectionChoice) => void;
}) {
  const t = useT();
  if (options.isPending) return <Loading />;
  if (options.error)
    return <ErrorNotice error={options.error} retry={() => void options.refetch()} />;
  if (!options.data) return null;
  const message = availability === 'unchecked' ? 'checking' : availability;
  return (
    <div className="creation-connection">
      <ConnectionFields options={options.data} value={value} onChange={onChange} focusOnEntry />
      <div
        className="connection-availability"
        role="status"
        aria-live="polite"
        data-state={message}
      >
        {message !== 'automatic' && t(`connection.availability.${message}`)}
      </div>
    </div>
  );
}
