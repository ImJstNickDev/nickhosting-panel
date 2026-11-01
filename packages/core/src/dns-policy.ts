import { z } from 'zod';
import type { PlatformConfig } from './config.js';
import { DomainError } from './errors.js';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const hostname = z
  .hostname()
  .max(253)
  .refine((value) => value === value.toLowerCase());
const label = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const dnsDomainSchema = z.strictObject({
  id,
  hostname,
  zoneId: z.string().regex(/^[a-f0-9]{32}$/),
  target: z.union([hostname, z.ipv4(), z.ipv6()]).optional(),
  enabled: z.boolean().default(true),
});
export const dnsDomainsSchema = z
  .array(dnsDomainSchema)
  .max(100)
  .refine(
    (domains) =>
      new Set(domains.map((domain) => domain.id)).size === domains.length &&
      new Set(domains.map((domain) => domain.hostname)).size === domains.length,
    'Duplicate domain identifier or hostname',
  );
export const dnsGamePoliciesSchema = z.record(
  id,
  z.strictObject({
    selection: z.enum(['all', 'allow', 'deny']).default('all'),
    domainIds: z.array(id).max(100).default([]),
    defaultDomainId: id.optional(),
    sharedLabel: label.optional(),
  }),
);
export const dnsBlockedTermsSchema = z
  .array(
    z.strictObject({
      value: z
        .string()
        .trim()
        .min(1)
        .max(63)
        .regex(/^[a-zA-Z0-9-]+$/),
      match: z.enum(['exact', 'word', 'substring']),
    }),
  )
  .max(1000);
export type DnsDomain = z.infer<typeof dnsDomainSchema>;
type Config = Pick<
  PlatformConfig,
  | 'dnsDomains'
  | 'dnsDefaultDomainId'
  | 'dnsGamePolicies'
  | 'dnsBlockedTerms'
  | 'dnsBaseDomain'
  | 'cloudflareZoneId'
  | 'dnsTarget'
  | 'dnsInstanceId'
>;
type Connection =
  | { mode: 'custom-subdomain'; srv?: { service: string; proto: 'tcp' | 'udp' } }
  | { mode: 'shared-host'; defaultLabel: string; allowCustomSubdomain: boolean }
  | { mode: 'static-host-port'; hostnameSettingKey: string };

/** Availability is for new choices only; durable DNS intents retain their zone/target. */
export function resolveDnsDomains(
  config: Config,
  _connection: Connection,
  gameId: string,
): DnsDomain[] {
  const domains = config.dnsDomains.length
    ? config.dnsDomains
    : config.dnsBaseDomain && config.cloudflareZoneId
      ? [
          {
            id: 'legacy',
            hostname: config.dnsBaseDomain.toLowerCase(),
            zoneId: config.cloudflareZoneId,
            target: config.dnsTarget,
            enabled: true,
          },
        ]
      : [];
  const policy = config.dnsGamePolicies[gameId];
  return domains
    .filter(
      (domain) =>
        domain.enabled &&
        (policy?.selection === 'allow'
          ? policy.domainIds.includes(domain.id)
          : policy?.selection === 'deny'
            ? !policy.domainIds.includes(domain.id)
            : true),
    )
    .map((domain) => ({ ...domain, target: domain.target ?? config.dnsTarget }))
    .filter((domain) => Boolean(domain.target));
}

export function resolveDnsOptions(config: Config, connection: Connection, gameId: string) {
  const domains = resolveDnsDomains(config, connection, gameId);
  const policy = config.dnsGamePolicies[gameId];
  const preferred =
    [policy?.defaultDomainId, config.dnsDefaultDomainId]
      .map((id) => domains.find((domain) => domain.id === id))
      .find(Boolean) ?? domains[0];
  const sharedLabel =
    connection.mode === 'shared-host' ? (policy?.sharedLabel ?? connection.defaultLabel) : null;
  const staticHostname =
    connection.mode === 'static-host-port'
      ? (config as unknown as Record<string, unknown>)[connection.hostnameSettingKey]
      : null;
  return {
    mode: connection.mode,
    customizable:
      connection.mode === 'custom-subdomain' ||
      (connection.mode === 'shared-host' && connection.allowCustomSubdomain),
    domains: domains.map(({ id, hostname }) => ({ id, hostname })),
    defaultDomainId: preferred?.id ?? null,
    defaultHostname:
      sharedLabel && preferred
        ? `${sharedLabel}.${preferred.hostname}`
        : typeof staticHostname === 'string'
          ? staticHostname
          : null,
    supportsSrv: connection.mode === 'custom-subdomain' && Boolean(connection.srv),
    configured:
      connection.mode === 'static-host-port'
        ? Boolean(staticHostname)
        : Boolean(config.dnsInstanceId && preferred?.target),
  };
}

// Platform service labels are reserved independently of the Owner's initially empty blacklist.
const reservedLabels = new Set([
  'www',
  'mail',
  'smtp',
  'imap',
  'pop',
  'ns',
  'ns1',
  'ns2',
  'api',
  'admin',
  'panel',
  'hub',
  'dev',
  'sftp',
  'ftp',
  'autodiscover',
  'autoconfig',
]);
export function validateDnsLabel(input: string, config: Pick<Config, 'dnsBlockedTerms'>): string {
  const value = input.trim().toLowerCase();
  if (!label.safeParse(value).success || value.startsWith('xn--') || reservedLabels.has(value))
    throw new DomainError('validation_failed');
  if (
    config.dnsBlockedTerms.some(({ value: term, match }) => {
      const lower = term.toLowerCase();
      return match === 'exact'
        ? value === lower
        : match === 'substring'
          ? value.includes(lower)
          : `-${value}-`.includes(`-${lower}-`);
    })
  )
    throw new DomainError('validation_failed');
  return value;
}

/** 64 unique short words, three draws: 262,144 candidates, reserved atomically in the DB. */
export const dnsNameWords = [
  'acorn',
  'amber',
  'apple',
  'aqua',
  'bag',
  'bear',
  'birch',
  'bird',
  'blue',
  'boat',
  'brook',
  'cake',
  'calm',
  'cat',
  'cedar',
  'cherry',
  'cloud',
  'coral',
  'cove',
  'cube',
  'cute',
  'dawn',
  'deer',
  'dove',
  'dune',
  'fern',
  'finch',
  'fox',
  'frog',
  'glade',
  'gold',
  'grove',
  'hill',
  'jade',
  'kite',
  'lake',
  'leaf',
  'lemon',
  'lime',
  'luna',
  'maple',
  'mint',
  'moon',
  'moss',
  'nest',
  'oak',
  'otter',
  'owl',
  'panda',
  'peach',
  'pearl',
  'pine',
  'plum',
  'pond',
  'rain',
  'reed',
  'rose',
  'ruby',
  'sand',
  'snow',
  'star',
  'sun',
  'teal',
  'wave',
] as const;
