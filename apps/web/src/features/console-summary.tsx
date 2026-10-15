import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client.js';
import { useFormat, useLocale, useT } from '../app/i18n.js';
import type { DisplayResources } from './console-resources.js';
import { type Connections, platformPath } from './service-contracts.js';
import './console-summary.css';

const iconPaths = {
  address: 'M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12ZM9 9a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  uptime: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  cpu: 'M7 7h10v10H7ZM9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4',
  memory: 'M3 7h18v10H3ZM7 10v4m5-4v4m5-4v4M7 17v3m5-3v3m5-3v3',
  disk: 'M5 4h14l2 10v6H3v-6L5 4ZM3 14h18M7 17h1m3 0h1',
  inbound: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  outbound: 'M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5',
};

function SummaryCard({
  icon,
  label,
  children,
  offline = false,
  muted = false,
}: {
  icon: keyof typeof iconPaths;
  label: string;
  children: ReactNode;
  offline?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="console-summary-card">
      <dt>
        <span className={`console-summary-icon${offline ? ' is-offline' : ''}`} aria-hidden="true">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
          >
            <path d={iconPaths[icon]} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        {label}
      </dt>
      <dd className={muted ? 'is-offline' : undefined}>{children}</dd>
    </div>
  );
}

function uptimeLabel(milliseconds: number, locale: string) {
  let remaining = Math.floor(milliseconds / 1000);
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as const;
  const parts: string[] = [];
  for (const [unit, seconds] of units) {
    const value = Math.floor(remaining / seconds);
    remaining %= seconds;
    if (value || parts.length || unit === 'second') {
      parts.push(
        new Intl.NumberFormat(locale, {
          style: 'unit',
          unit,
          unitDisplay: 'short',
          maximumFractionDigits: 0,
        }).format(value),
      );
    }
  }
  return parts.join(' ');
}

export function ConsoleSummary({
  serverId,
  resources,
  availability,
}: {
  serverId: string;
  resources?: DisplayResources;
  availability: 'loading' | 'unavailable' | 'ready';
}) {
  const t = useT(),
    format = useFormat(),
    { locale } = useLocale();
  const connections = useQuery({
    queryKey: ['connections', serverId],
    queryFn: () => api<Connections>(`${platformPath(serverId)}/connections`),
    refetchInterval: 15000,
  });
  // The connection contract identifies the player endpoint. An auxiliary query or
  // control port must never substitute for an unconfigured primary allocation.
  const endpoints =
    connections.data?.ports.filter((port) => port.primary && port.hostname && port.port) ?? [];
  const endpoint = endpoints.find((port) => port.status === 'configured') ?? endpoints[0];
  const address = endpoint?.displayAddress;
  const addressState = connections.data?.addressState;
  const missingAddress =
    addressState === 'pending'
      ? 'connection.addressPreparing'
      : addressState === 'uncertain' || addressState === 'deleting'
        ? 'connection.addressUnavailable'
        : 'web.unconfigured';
  const current = availability === 'ready' ? resources : undefined;
  const fallback = t(availability === 'loading' ? 'web.loading' : 'web.unavailable');
  const offline = current?.current_state === 'offline';
  const uptime = current?.resources.uptime;
  const duration = offline
    ? t('web.offline')
    : current?.current_state === 'starting'
      ? t('service.summary.starting')
      : current?.current_state === 'stopping'
        ? t('service.summary.stopping')
        : current && uptime !== undefined && Number.isFinite(uptime) && uptime >= 0
          ? uptimeLabel(uptime, locale === 'it' ? 'it-IT' : 'en-GB')
          : fallback;

  return (
    <dl className="console-summary" aria-label={t('service.summary.title')}>
      <SummaryCard icon="address" label={t('service.address')}>
        {connections.isPending ? (
          t('web.loading')
        ) : connections.error ? (
          <>
            <span>{t('web.unavailable')}</span>
            <button
              type="button"
              className="console-summary-retry secondary"
              disabled={connections.isFetching}
              onClick={() => void connections.refetch()}
            >
              {t('web.retry')}
            </button>
          </>
        ) : address ? (
          <>
            <Link className="console-summary-address" to={`/servers/${serverId}/network`}>
              {address}
            </Link>
            {endpoint?.status !== 'configured' && (
              <span className="console-summary-detail">{t(`web.${endpoint?.status}`)}</span>
            )}
          </>
        ) : (
          t(missingAddress)
        )}
      </SummaryCard>
      <SummaryCard icon="uptime" label={t('service.summary.uptime')} offline={offline}>
        {duration}
      </SummaryCard>
      <SummaryCard muted={offline} icon="cpu" label={t('service.summary.cpu')}>
        {offline
          ? t('web.offline')
          : current?.resources.cpu_absolute !== undefined
            ? new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
                style: 'percent',
                maximumFractionDigits: 1,
              }).format(current.resources.cpu_absolute / 100)
            : fallback}
      </SummaryCard>
      <SummaryCard muted={offline} icon="memory" label={t('web.memory')}>
        {offline
          ? t('web.offline')
          : current?.resources.memory_bytes !== undefined
            ? format.bytes(current.resources.memory_bytes)
            : fallback}
      </SummaryCard>
      <SummaryCard icon="disk" label={t('service.summary.disk')}>
        {current?.resources.disk_bytes !== undefined
          ? format.bytes(current.resources.disk_bytes)
          : fallback}
      </SummaryCard>
      <SummaryCard muted={offline} icon="inbound" label={t('service.summary.inbound')}>
        {offline
          ? t('web.offline')
          : current?.resources.network_rx_bytes !== undefined
            ? format.bytes(current.resources.network_rx_bytes)
            : fallback}
      </SummaryCard>
      <SummaryCard muted={offline} icon="outbound" label={t('service.summary.outbound')}>
        {offline
          ? t('web.offline')
          : current?.resources.network_tx_bytes !== undefined
            ? format.bytes(current.resources.network_tx_bytes)
            : fallback}
      </SummaryCard>
    </dl>
  );
}
