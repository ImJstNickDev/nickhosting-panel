import { createHash } from 'node:crypto';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, getSettings, secretStatus } from '@nickhosting/database';
import { probeRedis } from '@nickhosting/jobs';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { type Environment, hostSnapshotSchema } from './admission.js';
import { ownerOnly, parse } from './registry.js';

export type HealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'stale'
  | 'unknown'
  | 'unconfigured'
  | 'disabled';
export interface HealthCheck {
  status: HealthStatus;
  observedAt: string | null;
  reason?:
    | 'missing_configuration'
    | 'invalid_configuration'
    | 'no_observation'
    | 'invalid_observation'
    | 'expired_observation'
    | 'probe_failed'
    | 'stopped'
    | 'poll_failed';
}
const scopeHash = (value: string) => createHash('sha256').update(value).digest('hex');
const workerFreshnessMs = 30_000;

export function observationHealth(
  observedAt: Date | null,
  now: Date,
  maxAgeMs: number,
): HealthCheck {
  if (!observedAt) return { status: 'unknown', observedAt: null, reason: 'no_observation' };
  const age = now.getTime() - observedAt.getTime();
  if (!Number.isFinite(age) || age < 0)
    return { status: 'unknown', observedAt: null, reason: 'invalid_observation' };
  return {
    status: age > maxAgeMs ? 'stale' : 'healthy',
    observedAt: observedAt.toISOString(),
    ...(age > maxAgeMs ? { reason: 'expired_observation' as const } : {}),
  };
}

export async function recordWorkerHeartbeat(
  db: Kysely<Database>,
  instanceId: string,
  jobPrefix: string,
  state: 'running' | 'degraded' | 'stopped',
) {
  parse(z.uuid(), instanceId);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(jobPrefix)) throw new DomainError('configuration_invalid');
  await db
    .insertInto('service_heartbeats')
    .values({
      service: 'worker',
      instance_id: instanceId,
      scope_hash: scopeHash(jobPrefix),
      state,
      observed_at: sql<Date>`clock_timestamp()`,
    })
    .onConflict((conflict) =>
      conflict.columns(['service', 'instance_id']).doUpdateSet({
        state,
        observed_at: sql<Date>`clock_timestamp()`,
      }),
    )
    .execute();
}

/** A successful authenticated Core request proves contact only. It cannot prove
 * any listener, backend reachability, collision check or playable game state. */
export async function recordGatewayContact(db: Kysely<Database>, gatewayId: string) {
  parse(z.uuid(), gatewayId);
  await db
    .insertInto('service_heartbeats')
    .values({
      service: 'gateway',
      instance_id: gatewayId,
      scope_hash: scopeHash(gatewayId),
      state: 'contact',
      observed_at: sql<Date>`clock_timestamp()`,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['service', 'instance_id'])
        .doUpdateSet({
          observed_at: sql<Date>`clock_timestamp()`,
        })
        .where(
          'service_heartbeats.observed_at',
          '<',
          sql<Date>`clock_timestamp() - interval '5 seconds'`,
        ),
    )
    .execute();
}

export interface HealthOptions {
  management: () => Promise<{ adapter: Pick<PterodactylAdapter, 'discoverCapabilities'> }>;
  /** Isolated tests can substitute transport only; authorization and DB reads remain real. */
  redisProbe?: typeof probeRedis;
  now?: Date;
}
const reasonSchema = z.enum([
  'permission_denied',
  'unavailable',
  'invalid_response',
  'not_found',
  'rate_limited',
  'timeout',
  'conflict',
  'validation_failed',
]);

export async function getOwnerHealth(
  db: Kysely<Database>,
  context: AuthContext,
  env: Environment,
  options: HealthOptions,
) {
  ownerOnly(context);
  let now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  // Failure here yields the ordinary sanitized API error. No successful health
  // response can claim the DB worked just because a request reached the API.
  await sql`select 1`.execute(db);
  const { values: config } = await getSettings(db, env);
  const secrets = await secretStatus(db, env);
  const configured = (name: string) =>
    secrets.some((secret) => secret.name === name && secret.configured);
  const providerConfigured = Boolean(
    config.pterodactylBaseUrl &&
      configured('pterodactylApplicationKey') &&
      configured('pterodactylClientKey'),
  );
  const provider = async () => {
    if (!providerConfigured)
      return {
        status: 'unconfigured' as const,
        observedAt: null,
        readScopes: [],
        writeScopes: 'unverified' as const,
      };
    try {
      const result = await (await options.management()).adapter.discoverCapabilities();
      const readScopes = ['nodes', 'nests', 'servers', 'users', 'client'].map((scope) => {
        const value = result[scope];
        const reason = reasonSchema.safeParse(value?.reason);
        return {
          scope,
          available: value?.available === true,
          ...(value?.available === true
            ? {}
            : { reason: reason.success ? reason.data : 'unavailable' }),
        };
      });
      return {
        status: readScopes.every((scope) => scope.available)
          ? ('healthy' as const)
          : ('degraded' as const),
        observedAt: new Date().toISOString(),
        readScopes,
        writeScopes: 'unverified' as const,
      };
    } catch {
      return {
        status: 'unavailable' as const,
        observedAt: new Date().toISOString(),
        readScopes: [],
        writeScopes: 'unverified' as const,
      };
    }
  };
  const [
    redisStatus,
    providerState,
    workerRows,
    gatewayRow,
    hostRows,
    operationCounts,
    routeCounts,
  ] = await Promise.all([
    (options.redisProbe ?? probeRedis)(env.REDIS_URL),
    provider(),
    db
      .selectFrom('service_heartbeats')
      .select(['instance_id', 'state', 'observed_at'])
      .where('service', '=', 'worker')
      .where('scope_hash', '=', scopeHash(env.NH_JOB_PREFIX ?? ''))
      .orderBy('observed_at', 'desc')
      .limit(32)
      .execute(),
    config.gatewayId
      ? db
          .selectFrom('service_heartbeats')
          .select('observed_at')
          .where('service', '=', 'gateway')
          .where('instance_id', '=', config.gatewayId)
          .executeTakeFirst()
      : undefined,
    db
      .selectFrom('physical_hosts as host')
      .leftJoin('host_observations as observation', 'observation.host_id', 'host.id')
      .select([
        'host.id',
        'host.name',
        'host.enabled',
        'host.observer_id as expectedObserver',
        'observation.observer_id as observedBy',
        'observation.snapshot',
        'observation.observed_at',
      ])
      .orderBy('host.name')
      .limit(100)
      .execute(),
    sql<{ queued: string; running: string; failed: string; uncertain: string }>`select
      count(*) filter (where job.state = 'queued') as queued,
      count(*) filter (where job.state = 'running') as running,
      count(*) filter (where job.state = 'failed') as failed,
      count(*) filter (where operation.effect_state in ('prepared','uncertain')) as uncertain
      from operation_jobs job left join server_operations operation on operation.job_id = job.id`.execute(
      db,
    ),
    config.gatewayId
      ? sql<{ enabled: string; leased: string }>`select count(*) as enabled,
      count(*) filter (where lease_expires_at > ${now}) as leased from gateway_routes
      where enabled and gateway_id = ${config.gatewayId}`.execute(db)
      : undefined,
  ]);
  // Concurrent worker/observer writes during slow provider probes are not future
  // observations. Evaluate freshness against the actual completed read time.
  if (!options.now) now = new Date();
  const workerInstances = workerRows.map((row) => {
    const freshness = observationHealth(row.observed_at, now, workerFreshnessMs);
    return {
      instanceId: row.instance_id,
      ...freshness,
      ...(freshness.status === 'healthy' && row.state !== 'running'
        ? {
            status: row.state === 'stopped' ? ('unavailable' as const) : ('degraded' as const),
            reason: row.state === 'stopped' ? ('stopped' as const) : ('poll_failed' as const),
          }
        : {}),
    };
  });
  const currentWorkers = workerInstances.filter(
    (worker) => worker.status === 'healthy' || worker.status === 'degraded',
  );
  const workerStatus: HealthStatus = !env.NH_JOB_PREFIX
    ? 'unconfigured'
    : currentWorkers.some((worker) => worker.status === 'healthy')
      ? 'healthy'
      : currentWorkers.length
        ? 'degraded'
        : workerInstances.length
          ? (workerInstances[0]?.status ?? 'unknown')
          : 'unknown';
  const gatewayControl = !config.gatewayEnabled
    ? { status: 'disabled' as const, observedAt: null }
    : !config.gatewayId
      ? { status: 'unconfigured' as const, observedAt: null }
      : observationHealth(
          gatewayRow?.observed_at ?? null,
          now,
          Math.max(30_000, config.gatewayLeaseSeconds * 2000),
        );
  const hosts = hostRows.map((row) => {
    const snapshot = hostSnapshotSchema.safeParse(row.snapshot);
    let check = observationHealth(row.observed_at, now, config.observationMaxAgeSeconds * 1000);
    if (!row.enabled) check = { status: 'disabled', observedAt: null };
    else if (
      row.observed_at &&
      (row.expectedObserver !== row.observedBy ||
        !snapshot.success ||
        Date.parse(snapshot.data.observedAt) !== row.observed_at.getTime() ||
        snapshot.data.availableMemoryMiB > snapshot.data.totalMemoryMiB)
    )
      check = { status: 'unknown', observedAt: null, reason: 'invalid_observation' };
    return { id: row.id, name: row.name, ...check };
  });
  const counts = operationCounts.rows[0];
  const routes = routeCounts?.rows[0];
  return {
    checkedAt,
    api: { status: 'healthy' as const, observedAt: checkedAt },
    database: { status: 'healthy' as const, observedAt: checkedAt },
    redis: {
      status: redisStatus,
      observedAt: redisStatus === 'unconfigured' ? null : new Date().toISOString(),
    },
    worker: {
      status: workerStatus,
      observedAt: workerInstances[0]?.observedAt ?? null,
      check: 'poll_progress' as const,
      instances: workerInstances,
      maxInstances: 32,
      freshnessSeconds: workerFreshnessMs / 1000,
    },
    gateway: {
      controlPlane: gatewayControl,
      listenerReadiness: { status: 'unknown' as const, observedAt: null },
      routes: { enabled: Number(routes?.enabled ?? 0), leased: Number(routes?.leased ?? 0) },
    },
    provider: providerState,
    hosts: { items: hosts, limit: 100 },
    operations: {
      queued: Number(counts?.queued ?? 0),
      running: Number(counts?.running ?? 0),
      failed: Number(counts?.failed ?? 0),
      uncertain: Number(counts?.uncertain ?? 0),
    },
    services: {
      sftp: {
        configured: Boolean(
          config.sftpgoBaseUrl &&
            config.sftpgoDataRoot &&
            config.sftpgoInstanceId &&
            configured('sftpgoApiKey'),
        ),
        connectivity: 'unverified' as const,
        releaseGate: 18,
      },
      dns: {
        configured: Boolean(
          config.cloudflareZoneId &&
            config.dnsBaseDomain &&
            config.dnsTarget &&
            configured('cloudflareApiToken'),
        ),
        writes: 'unverified' as const,
      },
    },
  };
}
