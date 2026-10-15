import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ErrorNotice, Input, Select } from '../components/ui.js';
import './connection.css';

import type { ConnectionChoice, ConnectionOptions } from './connection.api.js';

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
}: {
  options: ConnectionOptions;
  value: ConnectionChoice;
  onChange: (choice: ConnectionChoice) => void;
}) {
  const t = useT();
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
}: {
  options: ReturnType<typeof useConnectionOptions>;
  value: ConnectionChoice;
  onChange: (choice: ConnectionChoice) => void;
}) {
  const t = useT();
  if (options.error) return <ErrorNotice error={options.error} />;
  if (!options.data?.configured) return null;
  return (
    <div className="creation-connection">
      <h3>{t('service.address')}</h3>
      <ConnectionFields options={options.data} value={value} onChange={onChange} />
    </div>
  );
}
