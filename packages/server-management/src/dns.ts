import { createHash, randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import {
  type AuthContext,
  DomainError,
  dnsNameWords,
  resolveDnsDomains,
  resolveDnsOptions,
  validateDnsLabel,
} from '@nickhosting/core';
import {
  type Database,
  getSecret,
  getSettings,
  recordAudit,
  secretStatus,
} from '@nickhosting/database';
import {
  CloudflareDnsProvider,
  type ConnectionPlan,
  type OwnedDnsRecord,
  ProviderRateLimitError,
  planConnection,
} from '@nickhosting/external-services';
import { evaluateGameAccess, gameManifestSchema } from '@nickhosting/game-sdk';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import { cachedDnsAvailability } from './dns-availability.js';
import { reserveDnsWizardHostname } from './dns-reservations.js';
import { dnsLocked, type ExternalServiceOptions, locked } from './external.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, parse } from './registry.js';

type DnsRow = Selectable<Database['dns_assignments']>;
type Authority =
  | { context: AuthContext; service?: never }
  | { service: 'server-default'; context?: never };
type DnsIntent = Authority & {
  version: 1 | 2;
  zoneId: string;
  instanceId: string;
  scope: string;
  connection: ConnectionPlan;
  confirmedConnection?: ConnectionPlan;
  action: 'apply' | 'delete';
  domainId?: string;
  sharedHostId?: string;
  request?: z.infer<typeof dnsRequest>;
};
type SharedIntent = {
  zoneId: string;
  instanceId: string;
  connection: Pick<ConnectionPlan, 'hostname' | 'records'>;
};
const now = (options: ExternalServiceOptions) => options.now?.() ?? new Date();
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const serverConnectionRequest = z
  .object({
    domainId: z.string().min(1).max(64).optional(),
    subdomain: z.string().min(1).max(63).optional(),
  })
  .strict();
const dnsRequest = serverConnectionRequest.extend({
  portRole: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/)
    .optional(),
});
async function integration(db: Kysely<Database>, serverId: string) {
  const server = await db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .executeTakeFirst();
  if (!server || server.deleted_at) throw new DomainError('not_found');
  const game = await db
    .selectFrom('runtime_egg_mappings as m')
    .innerJoin('game_integrations as g', 'g.id', 'm.game_id')
    .select(['g.id', 'g.manifest'])
    .where('m.id', '=', server.mapping_id)
    .executeTakeFirstOrThrow();
  return { server, gameId: game.id, manifest: parse(gameManifestSchema, game.manifest) };
}
export async function getServerConnectionOptions(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  env: ExternalServiceOptions['env'] = {},
) {
  await authorizeServer(db, context, serverId, 'server:read');
  const [game, settings] = await Promise.all([integration(db, serverId), getSettings(db, env)]);
  const options = resolveDnsOptions(settings.values, game.manifest.connection, game.gameId);
  const ready =
    options.mode === 'static-host-port' ||
    (await secretStatus(db, env)).some((s) => s.name === 'cloudflareApiToken' && s.configured);
  return { ...options, configured: options.configured && ready };
}
async function authorizedGameConnection(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
) {
  const game = await db
    .selectFrom('game_integrations as g')
    .innerJoin('game_rollouts as r', 'r.integration_id', 'g.id')
    .select(['g.manifest', 'r.state', 'r.allowlist'])
    .where('g.id', '=', gameId)
    .executeTakeFirst();
  if (
    !game ||
    !evaluateGameAccess(
      { gameId, state: game.state, allowedUserIds: game.allowlist },
      { userId: context.subjectUserId, role: context.role },
    ).canCreate
  )
    throw new DomainError('forbidden');
  return parse(gameManifestSchema, game.manifest).connection;
}
export async function getGameConnectionOptions(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  env: ExternalServiceOptions['env'] = {},
) {
  const [connection, settings] = await Promise.all([
    authorizedGameConnection(db, context, gameId),
    getSettings(db, env),
  ]);
  const options = resolveDnsOptions(settings.values, connection, gameId);
  const ready =
    options.mode === 'static-host-port' ||
    (await secretStatus(db, env)).some((s) => s.name === 'cloudflareApiToken' && s.configured);
  return { ...options, configured: options.configured && ready };
}
async function prepareGameConnectionLookup(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  domainId: string | undefined,
  options: ExternalServiceOptions,
) {
  if (context.sessionType !== 'regular') throw new DomainError('forbidden');
  const [connection, settings] = await Promise.all([
    authorizedGameConnection(db, context, gameId),
    getSettings(db, options.env),
  ]);
  if (
    connection.mode === 'static-host-port' ||
    (connection.mode === 'shared-host' && !connection.allowCustomSubdomain)
  )
    throw new DomainError('forbidden');
  const config = settings.values;
  const choices = resolveDnsOptions(config, connection, gameId);
  const domain = resolveDnsDomains(config, connection, gameId).find(
    (d) => d.id === (domainId ?? choices.defaultDomainId),
  );
  if (!domain || !choices.configured) throw new DomainError('configuration_invalid');
  return { connection, config, domain };
}
export async function getGameConnectionAvailability(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  const request = parse(serverConnectionRequest.required({ subdomain: true }), input);
  const lookup = await prepareGameConnectionLookup(db, context, gameId, request.domainId, options);
  const subdomain = validateDnsLabel(request.subdomain, lookup.config);
  return checkGameConnectionName(db, context, gameId, subdomain, lookup, options);
}
async function checkGameConnectionName(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  subdomain: string,
  { connection, config, domain }: Awaited<ReturnType<typeof prepareGameConnectionLookup>>,
  options: ExternalServiceOptions,
) {
  const hostname = `${subdomain}.${domain.hostname}`;
  if (hostname.length > 253) throw new DomainError('validation_failed');
  const reservation = await db
    .selectFrom('dns_hostname_reservations')
    .select(['hostname', 'wizard_user_id', 'wizard_game_id'])
    .where('hostname', '=', hostname)
    .where((eb) => eb.or([eb('release_after', 'is', null), eb('release_after', '>', now(options))]))
    .executeTakeFirst();
  if (reservation)
    return {
      available:
        reservation.wizard_user_id === context.subjectUserId &&
        reservation.wizard_game_id === gameId,
      hostname,
    };
  const key = await getSecret(db, options.codec, 'cloudflareApiToken', options.env);
  if (!key || !config.dnsInstanceId) throw new DomainError('configuration_invalid');
  const names = [
    hostname,
    ...(connection.mode === 'custom-subdomain' && connection.srv
      ? [`${connection.srv.service}._${connection.srv.proto}.${hostname}`]
      : []),
  ];
  const scope = fingerprint(key),
    cacheKey = fingerprint([scope, config.dnsInstanceId, domain.zoneId, names]);
  const available = await cachedDnsAvailability(
    scope,
    cacheKey,
    names.length,
    {
      cacheSeconds: config.dnsAvailabilityCacheSeconds,
      requestsPerMinute: config.dnsAvailabilityRequestsPerMinute,
      concurrency: config.dnsAvailabilityConcurrency,
    },
    async () => {
      const provider =
        options.dnsFactory?.(config, key) ??
        new CloudflareDnsProvider({ instanceId: config.dnsInstanceId ?? '', apiToken: key });
      if (!provider.hasRecordsAtName) throw new DomainError('integration_unavailable');
      const readName = provider.hasRecordsAtName.bind(provider);
      const results = await Promise.allSettled(names.map((name) => readName(domain.zoneId, name)));
      const limited = results.find(
        (result) => result.status === 'rejected' && result.reason instanceof ProviderRateLimitError,
      );
      if (limited?.status === 'rejected') throw limited.reason;
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      return results.every((result) => result.status === 'fulfilled' && !result.value);
    },
  );
  return { available, hostname };
}
/** Advisory only: selection is reserved by Next, never by a preview. */
export async function suggestGameConnection(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  const request = parse(serverConnectionRequest.pick({ domainId: true }), input);
  const lookup = await prepareGameConnectionLookup(db, context, gameId, request.domainId, options);
  const attempted = new Set<string>();
  let checks = 0;
  // Bound both local blacklist work and provider reads. Shared cache/rate budgets
  // apply unchanged; provider uncertainty aborts rather than trying another name.
  for (let draw = 0; draw < 32 && checks < 5; draw++) {
    let subdomain: string;
    try {
      subdomain = validateDnsLabel(randomLabel(), lookup.config);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'validation_failed') continue;
      throw error;
    }
    if (attempted.has(subdomain)) continue;
    attempted.add(subdomain);
    checks++;
    const result = await checkGameConnectionName(db, context, gameId, subdomain, lookup, options);
    if (result.available) return { ...result, domainId: lookup.domain.id, subdomain };
  }
  throw new DomainError('conflict');
}
export async function reserveGameConnection(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  const request = parse(
    serverConnectionRequest
      .required({ subdomain: true })
      .extend({ previousReservationId: z.uuid().optional() }),
    input,
  );
  const { previousReservationId, ...selection } = request;
  const availability = await getGameConnectionAvailability(db, context, gameId, selection, options);
  if (!availability.available) throw new DomainError('conflict');
  const [connection, settings] = await Promise.all([
    authorizedGameConnection(db, context, gameId),
    getSettings(db, options.env),
  ]);
  const choices = resolveDnsOptions(settings.values, connection, gameId);
  const domainId = request.domainId ?? choices.defaultDomainId;
  const domain = resolveDnsDomains(settings.values, connection, gameId).find(
    (d) => d.id === domainId,
  );
  if (!domain || !choices.configured || !choices.customizable)
    throw new DomainError('configuration_invalid');
  const subdomain = validateDnsLabel(request.subdomain, settings.values);
  const hostname = `${subdomain}.${domain.hostname}`;
  // Settings can change while the provider read is in flight. Never reserve a
  // different name than the one whose availability was actually checked.
  if (hostname !== availability.hostname) throw new DomainError('conflict');
  return reserveDnsWizardHostname(db, context, gameId, {
    domainId: domain.id,
    subdomain,
    hostname,
    previousReservationId,
  });
}
async function dnsProvider(db: Kysely<Database>, options: ExternalServiceOptions) {
  const { values: config } = await getSettings(db, options.env);
  const key = await getSecret(db, options.codec, 'cloudflareApiToken', options.env);
  if (!config.dnsInstanceId || !key) throw new DomainError('configuration_invalid');
  return {
    config,
    provider:
      options.dnsFactory?.(config, key) ??
      new CloudflareDnsProvider({ instanceId: config.dnsInstanceId, apiToken: key }),
  };
}
function randomLabel() {
  return Array.from({ length: 3 }, () => dnsNameWords[randomInt(dnsNameWords.length)]).join('-');
}
async function reserveName(
  db: Kysely<Database>,
  hostname: string,
  ownerId: string,
  options: ExternalServiceOptions,
) {
  await db
    .deleteFrom('dns_hostname_reservations')
    .where('hostname', '=', hostname)
    .where('release_after', '<=', now(options))
    .execute();
  await db
    .insertInto('dns_hostname_reservations')
    .values({ hostname, owner_id: ownerId, release_after: null })
    .onConflict((oc) => oc.column('hostname').doNothing())
    .execute();
  const reservation = await db
    .selectFrom('dns_hostname_reservations')
    .selectAll()
    .where('hostname', '=', hostname)
    .executeTakeFirstOrThrow();
  if (reservation.owner_id !== ownerId) throw new DomainError('conflict');
  await db
    .updateTable('dns_hostname_reservations')
    .set({ release_after: null })
    .where('hostname', '=', hostname)
    .execute();
}
async function releaseNames(
  db: Kysely<Database>,
  ownerId: string,
  keep: string | null,
  options: ExternalServiceOptions,
) {
  const delay = (await getSettings(db, options.env)).values.dnsNameReuseDelaySeconds;
  let query = db
    .updateTable('dns_hostname_reservations')
    .set({ release_after: new Date(now(options).getTime() + delay * 1000) })
    .where('owner_id', '=', ownerId)
    .where('release_after', 'is', null);
  if (keep) query = query.where('hostname', '!=', keep);
  await query.execute();
}
export async function releaseServerDnsClaims(
  db: Kysely<Database>,
  serverId: string,
  options: ExternalServiceOptions,
) {
  await releaseNames(db, serverId, null, options);
}
async function connectionPlan(
  db: Kysely<Database>,
  serverId: string,
  input: unknown,
  options: ExternalServiceOptions,
  ownerId?: string,
) {
  const request = parse(dnsRequest, input);
  const { server, manifest, gameId } = await integration(db, serverId);
  const { values: config } = await getSettings(db, options.env);
  const allocations = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .execute();
  const allocation = request.portRole
    ? allocations.find((a) => a.role === request.portRole)
    : allocations.find((a) => a.is_primary);
  if (!allocation || !manifest.ports.some((p) => p.role === allocation.role))
    throw new DomainError('configuration_invalid');
  const direct = server.connection_mode === 'direct' ? allocation.direct_endpoint : null;
  if (server.connection_mode === 'direct' && !direct)
    throw new DomainError('configuration_invalid');
  const srv =
    manifest.connection.mode === 'custom-subdomain' && allocation.is_primary
      ? manifest.connection.srv
      : undefined;
  const route =
    server.connection_mode === 'gateway'
      ? await db
          .selectFrom('gateway_routes')
          .select(['public_port', 'transport'])
          .where('allocation_id', '=', allocation.id)
          .where('enabled', '=', true)
          .execute()
      : [];
  // Legacy fixtures/installations have no route yet; a published Gateway address
  // always takes precedence over its private backend allocation.
  const port =
    direct?.port ??
    route.find((r) => r.transport === (srv?.proto ?? allocation.protocols[0]))?.public_port;
  if (!port) throw new DomainError('configuration_invalid');
  if (manifest.connection.mode === 'static-host-port') {
    if (request.subdomain || request.domainId) throw new DomainError('validation_failed');
    const host =
      direct?.hostname ??
      (config as unknown as Record<string, unknown>)[manifest.connection.hostnameSettingKey];
    if (typeof host !== 'string' || !host) throw new DomainError('configuration_invalid');
    return {
      connection: planConnection({ mode: 'static-host-port', hostname: host, port }),
      domain: null,
      shared: false,
      gameId,
    };
  }
  const choices = resolveDnsOptions(config, manifest.connection, gameId);
  const domains = resolveDnsDomains(config, manifest.connection, gameId);
  const domain = domains.find((d) => d.id === (request.domainId ?? choices.defaultDomainId));
  if (!domain || !config.dnsInstanceId) throw new DomainError('configuration_invalid');
  const shared = manifest.connection.mode === 'shared-host' && !request.subdomain;
  if (
    manifest.connection.mode === 'shared-host' &&
    request.subdomain &&
    !manifest.connection.allowCustomSubdomain
  )
    throw new DomainError('forbidden');
  const target = shared
    ? (domain.target ?? config.dnsTarget)
    : (direct?.hostname ?? domain.target ?? config.dnsTarget);
  if (!target) throw new DomainError('configuration_invalid');
  if (srv && !allocation.protocols.includes(srv.proto))
    throw new DomainError('configuration_invalid');
  let label = request.subdomain
    ? validateDnsLabel(request.subdomain, config)
    : shared
      ? (config.dnsGamePolicies[gameId]?.sharedLabel ??
        (manifest.connection.mode === 'shared-host' ? manifest.connection.defaultLabel : ''))
      : '';
  if (shared) label = validateDnsLabel(label, config);
  for (let attempt = 0; attempt < 32; attempt++) {
    if (!label) {
      try {
        label = validateDnsLabel(randomLabel(), config);
      } catch {
        continue;
      }
    }
    const connection = planConnection({
      mode: 'custom-subdomain',
      zoneName: domain.hostname,
      subdomain: label,
      port,
      target: {
        type: isIP(target) === 4 ? 'A' : isIP(target) === 6 ? 'AAAA' : 'CNAME',
        content: target,
      },
      srv: srv ? { service: srv.service, protocol: srv.proto } : undefined,
    });
    if (ownerId && !shared) {
      try {
        await reserveName(db, connection.hostname, ownerId, options);
      } catch (error) {
        if (request.subdomain) throw error;
        label = '';
        continue;
      }
    }
    return { connection, domain, shared, gameId };
  }
  throw new DomainError('conflict');
}
export async function previewServerDns(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  await authorizeServer(db, context, serverId, 'server:manage');
  const planned = await connectionPlan(db, serverId, input, options);
  return {
    ...planned.connection,
    domainId: planned.domain?.id ?? null,
    subdomain:
      planned.domain && !planned.shared
        ? planned.connection.hostname.slice(0, -planned.domain.hostname.length - 1)
        : null,
    shared: planned.shared,
  };
}
function publicDns(row: DnsRow) {
  const intent = row.plan as DnsIntent;
  return {
    id: row.id,
    serverId: row.server_id,
    state: row.state,
    domainId: intent.domainId ?? 'legacy',
    shared: Boolean(intent.sharedHostId),
    connection:
      row.state === 'active'
        ? intent.connection
        : (intent.confirmedConnection ?? intent.connection),
    updatedAt: row.updated_at,
  };
}
export async function listServerDns(db: Kysely<Database>, context: AuthContext, serverId: string) {
  await authorizeServer(db, context, serverId, 'server:read');
  return (
    await db
      .selectFrom('dns_assignments')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('state', '!=', 'deleted')
      .execute()
  ).map(publicDns);
}
async function authorizeIntent(db: Kysely<Database>, row: DnsRow, intent: DnsIntent) {
  if (intent.service === 'server-default') {
    const server = await db
      .selectFrom('managed_servers')
      .select(['deleted_at', 'pterodactyl_uuid'])
      .where('id', '=', row.server_id)
      .executeTakeFirst();
    const preference = await db
      .selectFrom('server_dns_preferences')
      .select('enabled')
      .where('server_id', '=', row.server_id)
      .executeTakeFirst();
    if (!server?.pterodactyl_uuid || server.deleted_at || !preference?.enabled)
      throw new DomainError('forbidden');
  } else {
    if (intent.context?.sessionType !== 'regular') throw new DomainError('forbidden');
    const user = await db
      .selectFrom('user')
      .select('role')
      .where('id', '=', intent.context.actorUserId)
      .executeTakeFirst();
    if (!user) throw new DomainError('forbidden');
    await authorizeServer(
      db,
      { ...intent.context, role: user.role },
      row.server_id,
      'server:manage',
    );
  }
}
export async function runDns(
  db: Kysely<Database>,
  row: DnsRow,
  options: ExternalServiceOptions,
): Promise<DnsRow> {
  const intent = row.plan as DnsIntent;
  const { config, provider } = await dnsProvider(db, options);
  const expected = fingerprint(
    intent.version === 1 ? [intent.zoneId, intent.instanceId] : [intent.instanceId],
  );
  if (
    ![1, 2].includes(intent.version) ||
    intent.scope !== expected ||
    intent.instanceId !== config.dnsInstanceId
  )
    throw new DomainError('configuration_invalid');
  const ownership = {
    instanceId: intent.instanceId,
    serverId: row.server_id,
    assignmentId: row.ownership_token,
  };
  let ledger = row.ledger as OwnedDnsRecord[];
  const persist = () =>
    db
      .updateTable('dns_assignments')
      .set({ ledger: JSON.stringify(ledger), updated_at: now(options) })
      .where('id', '=', row.id)
      .execute();
  const callbacks = {
    onRecordCreated: async (entry: OwnedDnsRecord) => {
      ledger = ledger.filter(
        (old) =>
          !(
            old.zoneId === entry.zoneId &&
            (old.id === entry.id ||
              (old.record.name === entry.record.name && old.record.type === entry.record.type))
          ),
      );
      ledger.push(entry);
      await persist();
    },
    onRecordDeleted: async (entry: OwnedDnsRecord) => {
      ledger = ledger.filter((old) => !(old.id === entry.id && old.zoneId === entry.zoneId));
      await persist();
    },
  };
  try {
    if (intent.action === 'apply') {
      await authorizeIntent(db, row, intent);
      await options.verifyServer(db, row.server_id);
      if (!intent.sharedHostId) {
        const changes = await provider.plan({
          zoneId: intent.zoneId,
          ownership,
          desired: intent.connection.records,
          ledger: ledger.filter((r) => r.zoneId === intent.zoneId),
        });
        await provider.apply(changes, callbacks);
        await provider.apply(
          ledger
            .filter(
              (entry) =>
                entry.zoneId !== intent.zoneId ||
                !intent.connection.records.some(
                  (desired) =>
                    desired.name === entry.record.name && desired.type === entry.record.type,
                ),
            )
            .map((previous) => ({ action: 'delete' as const, previous, record: previous.record })),
          callbacks,
        );
      } else if (ledger.length) {
        await provider.apply(
          ledger.map((previous) => ({
            action: 'delete' as const,
            previous,
            record: previous.record,
          })),
          callbacks,
        );
      }
      await db
        .updateTable('dns_assignments')
        .set({
          state: 'active',
          plan: JSON.stringify({ ...intent, confirmedConnection: intent.connection }),
          updated_at: now(options),
        })
        .where('id', '=', row.id)
        .execute();
      await releaseNames(db, row.id, intent.connection.hostname, options);
    } else {
      if (!intent.sharedHostId) {
        for (const recovered of await provider.inspectOwned({
          zoneId: intent.zoneId,
          ownership,
          desired: intent.connection.records,
        }))
          if (!ledger.some((e) => e.id === recovered.id && e.zoneId === recovered.zoneId)) {
            ledger.push(recovered);
            await persist();
          }
      }
      await provider.apply(
        ledger.map((previous) => ({
          action: 'delete' as const,
          previous,
          record: previous.record,
        })),
        callbacks,
      );
      await db
        .updateTable('dns_assignments')
        .set({ state: 'deleted', hostname: `deleted:${row.id}`, updated_at: now(options) })
        .where('id', '=', row.id)
        .execute();
      await releaseNames(db, row.id, null, options);
    }
  } catch (error) {
    await db
      .updateTable('dns_assignments')
      .set({
        state: intent.action === 'delete' ? 'deleting' : 'uncertain',
        updated_at: now(options),
      })
      .where('id', '=', row.id)
      .execute();
    throw error;
  }
  return db
    .selectFrom('dns_assignments')
    .selectAll()
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow();
}
/** Shared host lifetime is integration/domain scoped, never an individual server's. */
async function ensureSharedHost(
  db: Kysely<Database>,
  gameId: string,
  domainId: string,
  zoneId: string,
  connection: Pick<ConnectionPlan, 'hostname' | 'records'>,
  options: ExternalServiceOptions,
) {
  const { config, provider } = await dnsProvider(db, options);
  const scopeKey = `${gameId}:${domainId}:${connection.hostname}`;
  let row = await db
    .selectFrom('shared_dns_hosts')
    .selectAll()
    .where('scope_key', '=', scopeKey)
    .executeTakeFirst();
  if (!row) {
    row = await db.transaction().execute(async (tx) => {
      const id = randomUUID();
      await reserveName(tx, connection.hostname, id, options);
      return tx
        .insertInto('shared_dns_hosts')
        .values({
          id,
          scope_key: scopeKey,
          hostname: connection.hostname,
          ownership_token: randomUUID(),
          plan: JSON.stringify({ zoneId, instanceId: config.dnsInstanceId, connection }),
          ledger: '[]',
          state: 'pending',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  let intent = row.plan as SharedIntent;
  if (intent.zoneId !== zoneId || intent.instanceId !== config.dnsInstanceId)
    throw new DomainError('configuration_invalid');
  if (!isDeepStrictEqual(intent.connection.records, connection.records)) {
    intent = { ...intent, connection };
    row = await db
      .updateTable('shared_dns_hosts')
      .set({ plan: JSON.stringify(intent), state: 'pending', updated_at: now(options) })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  if (row.state === 'active') return row.id;
  const ownership = {
    instanceId: intent.instanceId,
    serverId: row.id,
    assignmentId: row.ownership_token,
  };
  let ledger = row.ledger as OwnedDnsRecord[];
  const persist = () =>
    db
      .updateTable('shared_dns_hosts')
      .set({ ledger: JSON.stringify(ledger), updated_at: now(options) })
      .where('id', '=', row.id)
      .execute();
  try {
    await provider.apply(
      await provider.plan({ zoneId, ownership, desired: connection.records, ledger }),
      {
        onRecordCreated: async (entry) => {
          ledger = ledger.filter((e) => e.id !== entry.id);
          ledger.push(entry);
          await persist();
        },
        onRecordDeleted: async (entry) => {
          ledger = ledger.filter((e) => e.id !== entry.id);
          await persist();
        },
      },
    );
    await db
      .updateTable('shared_dns_hosts')
      .set({ state: 'active', updated_at: now(options) })
      .where('id', '=', row.id)
      .execute();
    return row.id;
  } catch (error) {
    await db
      .updateTable('shared_dns_hosts')
      .set({ state: 'uncertain', updated_at: now(options) })
      .where('id', '=', row.id)
      .execute();
    throw error;
  }
}
async function prepareAssignment(
  db: Kysely<Database>,
  authority: Authority,
  serverId: string,
  value: z.infer<typeof dnsRequest> & { assignmentId: string },
  options: ExternalServiceOptions,
) {
  let row = await db
    .selectFrom('dns_assignments')
    .selectAll()
    .where('id', '=', value.assignmentId)
    .executeTakeFirst();
  if (row) {
    if (row.server_id !== serverId || ['deleted', 'deleting'].includes(row.state))
      throw new DomainError('conflict');
    const prior = row.plan as DnsIntent;
    const { assignmentId: _id, ...requested } = value;
    if (
      prior.context &&
      authority.context &&
      prior.context.actorUserId !== authority.context.actorUserId
    )
      throw new DomainError('conflict');
    if (
      prior.request &&
      Object.keys(requested).length &&
      !isDeepStrictEqual(prior.request, requested)
    )
      throw new DomainError('conflict');
    return row.state === 'active' ? row : runDns(db, row, options);
  }
  const { assignmentId, ...request } = value;
  let planned = await connectionPlan(db, serverId, request, options);
  if (!planned.connection.records.length)
    return { id: null, serverId, state: 'static' as const, connection: planned.connection };
  const { config } = await dnsProvider(db, options);
  if (!planned.domain || !config.dnsInstanceId) throw new DomainError('configuration_invalid');
  const sharedHostId = planned.shared
    ? await ensureSharedHost(
        db,
        planned.gameId,
        planned.domain.id,
        planned.domain.zoneId,
        planned.connection,
        options,
      )
    : undefined;
  row = await db.transaction().execute(async (tx) => {
    if (!sharedHostId) planned = await connectionPlan(tx, serverId, request, options, assignmentId);
    if (!planned.domain || !config.dnsInstanceId) throw new DomainError('configuration_invalid');
    const intent: DnsIntent = {
      ...authority,
      version: 2,
      zoneId: planned.domain.zoneId,
      domainId: planned.domain.id,
      instanceId: config.dnsInstanceId,
      scope: fingerprint([config.dnsInstanceId]),
      connection: planned.connection,
      request,
      action: 'apply',
      ...(sharedHostId ? { sharedHostId } : {}),
    };
    const inserted = await tx
      .insertInto('dns_assignments')
      .values({
        id: assignmentId,
        server_id: serverId,
        hostname: sharedHostId ? `shared:${assignmentId}` : planned.connection.hostname,
        ownership_token: randomUUID(),
        plan: JSON.stringify(intent),
        ledger: '[]',
        state: 'pending',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('server_dns_preferences')
      .values({
        server_id: serverId,
        domain_id: planned.domain.id,
        subdomain: request.subdomain ?? null,
        assignment_id: assignmentId,
        enabled: true,
      })
      .onConflict((oc) =>
        oc.column('server_id').doUpdateSet({
          assignment_id: assignmentId,
          domain_id: planned.domain?.id,
          subdomain: request.subdomain ?? null,
          enabled: true,
        }),
      )
      .execute();
    if (authority.context)
      await recordAudit(tx, authority.context, 'server.dns.assigned', { serverId, assignmentId });
    return inserted;
  });
  return runDns(db, row, options);
}
export async function assignServerDns(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  const value = parse(dnsRequest.extend({ assignmentId: z.uuid().optional() }), input);
  return locked(db, serverId, (connection) =>
    dnsLocked(connection, async () => {
      const verified = await currentInteractiveContext(connection, context, options.env ?? {});
      const server = await authorizeServer(connection, verified, serverId, 'server:manage');
      if (server.active_operation_id || !server.pterodactyl_uuid) throw new DomainError('conflict');
      const preference = await connection
        .selectFrom('server_dns_preferences')
        .select('assignment_id')
        .where('enabled', '=', true)
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      const existing = preference?.assignment_id
        ? undefined
        : await connection
            .selectFrom('dns_assignments')
            .select('id')
            .where('server_id', '=', serverId)
            .where('state', 'not in', ['deleted', 'deleting'])
            .orderBy('updated_at')
            .orderBy('id')
            .executeTakeFirst();
      const primaryId = preference?.assignment_id ?? existing?.id;
      if (value.assignmentId && primaryId && value.assignmentId !== primaryId) {
        const legacy = await connection
          .selectFrom('dns_assignments')
          .select('id')
          .where('id', '=', value.assignmentId)
          .where('server_id', '=', serverId)
          .where('state', 'not in', ['deleted', 'deleting'])
          .executeTakeFirst();
        if (!legacy) throw new DomainError('conflict');
      }
      const assignmentId =
        value.assignmentId ?? primaryId ?? (preference ? serverId : randomUUID());
      const result = await prepareAssignment(
        connection,
        { context: verified },
        serverId,
        { ...value, assignmentId },
        options,
      );
      if ('server_id' in result && !preference) {
        await connection
          .insertInto('server_dns_preferences')
          .values({
            server_id: serverId,
            domain_id: (result.plan as DnsIntent).domainId ?? 'legacy',
            subdomain: null,
            assignment_id: primaryId ?? result.id,
            enabled: true,
          })
          .onConflict((oc) =>
            oc
              .column('server_id')
              .doUpdateSet({ assignment_id: primaryId ?? result.id, enabled: true }),
          )
          .execute();
      }
      return 'server_id' in result ? publicDns(result) : result;
    }),
  );
}
export async function updateServerDns(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  assignmentId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  parse(z.uuid(), assignmentId);
  return locked(db, serverId, (connection) =>
    dnsLocked(connection, async () => {
      const verified = await currentInteractiveContext(connection, context, options.env ?? {});
      const server = await authorizeServer(connection, verified, serverId, 'server:manage');
      if (server.active_operation_id) throw new DomainError('conflict');
      const row = await connection
        .selectFrom('dns_assignments')
        .selectAll()
        .where('id', '=', assignmentId)
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      if (!row || row.state === 'deleted') throw new DomainError('not_found');
      if (row.state !== 'active') throw new DomainError('conflict');
      const request = parse(dnsRequest, input);
      const planned = await connectionPlan(connection, serverId, request, options);
      if (!planned.domain) throw new DomainError('conflict');
      const sharedHostId = planned.shared
        ? await ensureSharedHost(
            connection,
            planned.gameId,
            planned.domain.id,
            planned.domain.zoneId,
            planned.connection,
            options,
          )
        : undefined;
      const previous = row.plan as DnsIntent;
      const intent: DnsIntent = {
        version: 2,
        context: verified,
        zoneId: planned.domain.zoneId,
        domainId: planned.domain.id,
        instanceId: previous.instanceId,
        scope: fingerprint([previous.instanceId]),
        connection: planned.connection,
        confirmedConnection: previous.connection,
        request,
        action: 'apply',
        ...(sharedHostId ? { sharedHostId } : {}),
      };
      await connection.transaction().execute(async (tx) => {
        if (!sharedHostId)
          await reserveName(tx, planned.connection.hostname, assignmentId, options);
        await tx
          .updateTable('dns_assignments')
          .set({
            hostname: sharedHostId ? `shared:${assignmentId}` : planned.connection.hostname,
            plan: JSON.stringify(intent),
            state: 'pending',
            updated_at: now(options),
          })
          .where('id', '=', assignmentId)
          .execute();
        await recordAudit(tx, verified, 'server.dns.updated', { serverId, assignmentId });
      });
      return publicDns(
        await runDns(
          connection,
          await connection
            .selectFrom('dns_assignments')
            .selectAll()
            .where('id', '=', assignmentId)
            .executeTakeFirstOrThrow(),
          options,
        ),
      );
    }),
  );
}
export async function deleteDnsRow(
  db: Kysely<Database>,
  row: DnsRow,
  options: ExternalServiceOptions,
) {
  if (row.state === 'deleted') return row;
  await db
    .updateTable('dns_assignments')
    .set({
      plan: JSON.stringify({ ...(row.plan as DnsIntent), action: 'delete' }),
      state: 'deleting',
    })
    .where('id', '=', row.id)
    .execute();
  return runDns(
    db,
    await db
      .selectFrom('dns_assignments')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow(),
    options,
  );
}
export async function deleteServerDns(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  assignmentId: string,
  options: ExternalServiceOptions,
) {
  parse(z.uuid(), assignmentId);
  return locked(db, serverId, (connection) =>
    dnsLocked(connection, async () => {
      const verified = await currentInteractiveContext(connection, context, options.env ?? {});
      await authorizeServer(connection, verified, serverId, 'server:manage');
      const row = await connection
        .selectFrom('dns_assignments')
        .selectAll()
        .where('id', '=', assignmentId)
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      if (!row) throw new DomainError('not_found');
      await connection
        .updateTable('server_dns_preferences')
        .set({ enabled: false })
        .where('server_id', '=', serverId)
        .execute();
      await recordAudit(connection, verified, 'server.dns.deleted', { serverId, assignmentId });
      return publicDns(await deleteDnsRow(connection, row, options));
    }),
  );
}
async function reconcileSharedDnsHosts(db: Kysely<Database>, options: ExternalServiceOptions) {
  const { values: config } = await getSettings(db, options.env);
  if (
    !config.dnsInstanceId ||
    !(await secretStatus(db, options.env)).some(
      (s) => s.name === 'cloudflareApiToken' && s.configured,
    )
  )
    return { recovered: 0, failed: 0 };
  const games = await db.selectFrom('game_integrations').select(['id', 'manifest']).execute();
  let recovered = 0,
    failed = 0;
  for (const game of games) {
    const manifest = gameManifestSchema.safeParse(game.manifest);
    if (!manifest.success || manifest.data.connection.mode !== 'shared-host') continue;
    for (const domain of resolveDnsDomains(config, manifest.data.connection, game.id)) {
      if (!domain.target) continue;
      try {
        const label = validateDnsLabel(
          config.dnsGamePolicies[game.id]?.sharedLabel ?? manifest.data.connection.defaultLabel,
          config,
        );
        const connection = planConnection({
          mode: 'custom-subdomain',
          zoneName: domain.hostname,
          subdomain: label,
          // Shared host records have no port/SRV; this satisfies the pure planner
          // input only. Each server's displayed port comes from its own endpoint.
          port: 1,
          target: {
            type: isIP(domain.target) === 4 ? 'A' : isIP(domain.target) === 6 ? 'AAAA' : 'CNAME',
            content: domain.target,
          },
        });
        await db
          .connection()
          .execute((connectionDb) =>
            dnsLocked(connectionDb, () =>
              ensureSharedHost(
                connectionDb,
                game.id,
                domain.id,
                domain.zoneId,
                { hostname: connection.hostname, records: connection.records },
                options,
              ),
            ),
          );
        recovered++;
      } catch {
        failed++;
      }
    }
  }
  return { recovered, failed };
}
export async function reconcileAutomaticDns(db: Kysely<Database>, options: ExternalServiceOptions) {
  const { values: config } = await getSettings(db, options.env);
  await db
    .updateTable('dns_hostname_reservations')
    .set({
      release_after: new Date(now(options).getTime() + config.dnsNameReuseDelaySeconds * 1000),
    })
    .where('release_after', 'is', null)
    .where('wizard_user_id', 'is', null)
    .where(
      'owner_id',
      'in',
      db.selectFrom('managed_servers').select('id').where('deleted_at', 'is not', null),
    )
    .execute();
  const candidates = await db
    .selectFrom('server_dns_preferences as p')
    .innerJoin('managed_servers as s', 's.id', 'p.server_id')
    .selectAll('p')
    .where('p.enabled', '=', true)
    .where('p.assignment_id', 'is', null)
    .where('s.deleted_at', 'is', null)
    .where('s.pterodactyl_uuid', 'is not', null)
    .where('s.active_operation_id', 'is', null)
    .orderBy('p.updated_at')
    .limit(25)
    .execute();
  let { recovered, failed } = await reconcileSharedDnsHosts(db, options);
  for (const candidate of candidates)
    try {
      await locked(db, candidate.server_id, (connection) =>
        dnsLocked(connection, async () => {
          const current = await connection
            .selectFrom('server_dns_preferences')
            .selectAll()
            .where('server_id', '=', candidate.server_id)
            .executeTakeFirstOrThrow();
          if (!current.enabled || current.assignment_id) return;
          const server = await connection
            .selectFrom('managed_servers')
            .select(['deleted_at', 'active_operation_id', 'pterodactyl_uuid'])
            .where('id', '=', candidate.server_id)
            .executeTakeFirst();
          if (
            !server ||
            server.deleted_at ||
            server.active_operation_id ||
            !server.pterodactyl_uuid
          )
            return;
          await prepareAssignment(
            connection,
            { service: 'server-default' },
            candidate.server_id,
            {
              assignmentId: candidate.server_id,
              ...(current.domain_id ? { domainId: current.domain_id } : {}),
              ...(current.subdomain ? { subdomain: current.subdomain } : {}),
            },
            options,
          );
        }),
      );
      recovered++;
    } catch {
      failed++;
      await db
        .updateTable('server_dns_preferences')
        .set({ updated_at: now(options) })
        .where('server_id', '=', candidate.server_id)
        .execute();
    }
  return { recovered, failed };
}
