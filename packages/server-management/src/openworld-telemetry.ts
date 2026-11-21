import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  type AuthContext,
  assertAuthContext,
  DomainError,
  ownerServerPermissionKeys,
} from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  OpenworldTokenExpired,
  openworldDashboardToken,
  readOpenworldTelemetry,
} from '../../../games/openworld/src/dashboard-api.js';
import { readOpenworldPlayerSkin } from '../../../games/openworld/src/player-skin.js';
import {
  type OpenworldObservation,
  type OpenworldObservationReason,
  type OpenworldTelemetryData,
  type OpenworldTelemetryResource,
  openworldTelemetrySchemas,
} from '../../../games/openworld/src/telemetry.js';
import { privateBackendAddress } from './allocation-pool.js';
import { directoryServerIdentity } from './directory-identity.js';
import { managedIdentityClaims } from './managed-identity.js';
import { serverPermissionDefinitionsForGame, sharedServerPermissionKeys } from './registry.js';

type Resource = OpenworldTelemetryResource;
type SnapshotResource = Exclude<Resource, 'player'>;
type Sample = { data: OpenworldTelemetryData[Resource]; observedAt: number };
export type OpenworldScope = {
  serverId: string;
  binding: string;
  liveKey: string;
  origin: string;
  canManageCheckpoints?: boolean;
  canInspectPlayers?: boolean;
  reason: OpenworldObservationReason | null;
};
export type OpenworldPlayerSelection = { id: number; name: string; joinedAt?: number };
type Token = { origin: string; token: string };

const freshness: Record<Resource, number> = {
  status: 1500,
  players: 2000,
  player: 1500,
  history: 5000,
  chunks: 5000,
  storage: 15000,
};

// A pending read belongs to the server, not to the initiating browser. Limit active
// as well as completed entries so a burst cannot create unbounded upstream work.
export function sharedReads<T>(max: number, clock: () => number, failureTtl: number) {
  const entries = new Map<string, { promise: Promise<T>; expires: number }>();
  return {
    get(key: string, ttl: number, load: () => Promise<T>) {
      const now = clock();
      const prior = entries.get(key);
      if (prior && prior.expires > now) return prior.promise;
      if (entries.size >= max && !prior) {
        const evictable = [...entries].find(([, entry]) => entry.expires !== Infinity);
        if (!evictable) throw new DomainError('rate_limited');
        entries.delete(evictable[0]);
      }
      const entry = { promise: Promise.resolve().then(load), expires: Infinity };
      entries.set(key, entry);
      entry.promise.then(
        () => {
          entry.expires = clock() + ttl;
        },
        (error: unknown) => {
          const wait =
            error instanceof PterodactylError && error.reason === 'rate_limited'
              ? Math.max(failureTtl, error.retryAfterMs ?? 60_000)
              : failureTtl;
          entry.expires = clock() + wait;
        },
      );
      return entry.promise;
    },
    completed(key: string) {
      const entry = entries.get(key);
      return !!entry && Number.isFinite(entry.expires) && entry.expires > clock();
    },
    invalidate(key: string) {
      entries.delete(key);
    },
    current(key: string, promise: Promise<T>) {
      return entries.get(key)?.promise === promise;
    },
    discard(key: string, promise: Promise<T>) {
      if (entries.get(key)?.promise === promise) entries.delete(key);
    },
  };
}

export type OpenworldPlayerGrant = 'moderate' | 'screenshots';
export async function readOpenworldScope(
  db: Kysely<Database>,
  serverId: string,
  reader?:
    | { who: AuthContext; resource: Resource | 'factories'; playerGrant?: OpenworldPlayerGrant }
    | {
        who: AuthContext;
        resource: 'map';
        manageCheckpoints?: boolean;
        requirePlayerInspection?: boolean;
      },
): Promise<OpenworldScope> {
  if (reader) assertAuthContext(reader.who);
  if (!z.uuid().safeParse(serverId).success) throw new DomainError('validation_failed');
  // Resolve current grants and the private instance binding together on every read,
  // including when the data can be served from a cross-reader cache.
  const scope = await db
    .selectFrom('managed_servers as server')
    .innerJoin('openworld_server_profiles as p', 'p.server_id', 'server.id')
    .innerJoin('runtime_egg_mappings as m', 'm.id', 'server.mapping_id')
    .innerJoin('managed_nodes as n', 'n.id', 'server.node_id')
    .leftJoin('provider_accounts as account', 'account.user_id', 'server.owner_id')
    .leftJoin('project_members as member', (join) =>
      join
        .onRef('member.project_id', '=', 'server.project_id')
        .on('member.user_id', '=', reader?.who.subjectUserId ?? ''),
    )
    .leftJoin('server_subusers as sub', (join) =>
      join
        .onRef('sub.server_id', '=', 'server.id')
        .on('sub.user_id', '=', reader?.who.subjectUserId ?? ''),
    )
    .leftJoin('server_allocations as a', (join) =>
      join
        .onRef('a.server_id', '=', 'p.server_id')
        .onRef('a.node_id', '=', 'server.node_id')
        .on('a.role', '=', 'dashboard'),
    )
    .leftJoin('gateway_server_states as g', 'g.server_id', 'p.server_id')
    .leftJoin('resource_reservations as r', 'r.server_id', 'p.server_id')
    .leftJoin('provider_server_projections as v', 'v.server_id', 'p.server_id')
    .selectAll('server')
    .select([
      'member.role as member_role',
      'sub.permission_keys',
      'p.sha256',
      'p.dashboard_credential_prepared',
      'm.nest_id',
      'm.egg_id',
      'a.backend_address',
      'a.port',
      'a.private_only',
      'a.direct_endpoint',
      'a.protocols',
      'g.process_started_at',
      'r.operation_id',
      'v.identity_invalidated',
      'v.revision',
      'v.valid',
      'n.pterodactyl_node_id',
      'account.instance_id as provider_instance',
      'account.provider_url',
      managedIdentityClaims(serverId).as('claims'),
    ])
    .where('server.id', '=', serverId)
    .where('server.deleted_at', 'is', null)
    .where('m.game_id', '=', 'openworld')
    .where('m.runtime_id', '=', 'dedicated')
    .executeTakeFirst();
  if (!scope) throw new DomainError('not_found');
  let canManageCheckpoints = false;
  let canInspectPlayers = false;
  if (reader) {
    const { who, resource } = reader;
    const definitions = serverPermissionDefinitionsForGame('openworld');
    const keys =
      who.role === 'owner' || scope.owner_id === who.subjectUserId
        ? ownerServerPermissionKeys(
            definitions,
            who.sessionType === 'regular' && scope.owner_id === who.subjectUserId,
          )
        : sharedServerPermissionKeys(
            definitions,
            scope.member_role ?? undefined,
            scope.permission_keys,
          );
    if (reader.resource === 'map') {
      canManageCheckpoints = keys.includes('game.openworld.checkpoints.manage');
      canInspectPlayers =
        keys.includes('game.openworld.players.read') &&
        keys.includes('game.openworld.players.inspect');
      if (
        !keys.includes('game.openworld.map.read') ||
        (reader.manageCheckpoints && !canManageCheckpoints) ||
        (reader.requirePlayerInspection && !canInspectPlayers)
      )
        throw new DomainError('forbidden');
    } else {
      const roster = resource === 'players' || resource === 'player';
      if (
        !keys.includes(
          roster ? 'game.openworld.players.read' : 'game.openworld.performance.read',
        ) ||
        (resource === 'player' && !keys.includes('game.openworld.players.inspect')) ||
        (reader.playerGrant && !keys.includes(`game.openworld.players.${reader.playerGrant}`))
      )
        throw new DomainError('forbidden');
    }
  }
  if (scope.identity_invalidated) throw new DomainError('provenance_mismatch');
  const binding = createHash('sha256')
    .update(
      JSON.stringify([
        directoryServerIdentity(scope),
        scope.mapping_id,
        scope.nest_id,
        scope.egg_id,
        scope.sha256,
        scope.pterodactyl_node_id,
        scope.provider_instance,
        scope.provider_url,
        scope.claims,
      ]),
    )
    .digest('hex');
  // Snapshots survive power cycles. Credentials and live values belong to one running process.
  const liveKey = JSON.stringify([
    binding,
    scope.process_started_at ?? scope.operation_id ?? scope.updated_at,
    scope.operation_id,
    scope.revision,
    scope.valid,
  ]);
  const ready =
    scope.installation_state === 'installed' &&
    scope.runtime_state === 'running' &&
    scope.dashboard_credential_prepared;
  if (!ready)
    return {
      serverId,
      binding,
      liveKey,
      origin: '',
      reason: scope.runtime_state === 'offline' ? 'offline' : 'not_ready',
    };
  if (
    !scope.pterodactyl_uuid ||
    !scope.private_only ||
    scope.direct_endpoint ||
    !scope.protocols?.includes('tcp') ||
    !scope.port ||
    !scope.backend_address ||
    !privateBackendAddress(scope.backend_address)
  )
    throw new DomainError('provenance_mismatch');
  const host =
    isIP(scope.backend_address) === 6 ? `[${scope.backend_address}]` : scope.backend_address;
  return {
    serverId,
    binding,
    liveKey,
    canManageCheckpoints,
    canInspectPlayers,
    reason: null,
    origin: `http://${host}:${scope.port}`,
  };
}

export function assertCurrentOpenworldScope(before: OpenworldScope, after: OpenworldScope) {
  if (before.binding !== after.binding) throw new DomainError('provenance_mismatch');
  if (after.reason || before.liveKey !== after.liveKey) throw new DomainError('game_not_ready');
}

function rosterChanged(previous: Sample, next: Sample) {
  const before = (previous.data as OpenworldTelemetryData['players']).players;
  const after = (next.data as OpenworldTelemetryData['players']).players;
  if (before.length !== after.length) return true;
  const byId = new Map(before.map((p) => [p.id, p]));
  return after.some((p) => {
    const prior = byId.get(p.id);
    return (
      !prior ||
      prior.name !== p.name ||
      (p.connectedS != null &&
        prior.connectedS != null &&
        Math.abs(next.observedAt - previous.observedAt - (p.connectedS - prior.connectedS) * 1000) >
          5000)
    );
  });
}

function sampleKey(scope: OpenworldScope, resource: Resource, id?: number) {
  return JSON.stringify([scope.liveKey, resource, id]);
}

function assertSelection(
  member: { id: number; name: string; connectedS?: number | null } | undefined,
  selected: OpenworldPlayerSelection,
  observedAt: number,
) {
  if (
    !member ||
    member.id !== selected.id ||
    member.name !== selected.name ||
    (selected.joinedAt !== undefined &&
      (member.connectedS == null ||
        Math.abs(observedAt - member.connectedS * 1000 - selected.joinedAt) > 5000))
  )
    throw new DomainError('not_found');
}

export type OpenworldNativeOptions = {
  db: Kysely<Database>;
  target: (serverId: string) => Promise<{ address: string; password: string }>;
  fetcher?: typeof fetch;
  now?: () => number;
};

export function openworldProcessRef(scope: OpenworldScope) {
  return createHash('sha256').update(scope.liveKey).digest('hex');
}

export function createOpenworldNativeConnection(options: OpenworldNativeOptions) {
  const { db, target, fetcher = fetch, now = Date.now } = options;
  const tokens = sharedReads<Token>(128, now, 5000);
  async function native<T>(
    scope: OpenworldScope,
    work: (origin: string, token: string, signal: AbortSignal) => Promise<T>,
    retryExpired = true,
  ) {
    const signal = AbortSignal.timeout(8000);
    const credential = () =>
      tokens.get(scope.liveKey, 60000, async () => {
        const verified = await target(scope.serverId);
        assertCurrentOpenworldScope(scope, await readOpenworldScope(db, scope.serverId));
        if (verified.address !== scope.origin) throw new DomainError('provenance_mismatch');
        return {
          origin: verified.address,
          token: await openworldDashboardToken(
            verified.address,
            verified.password,
            signal,
            fetcher,
          ),
        };
      });
    const current = credential();
    const auth = await current;
    try {
      return await work(auth.origin, auth.token, signal);
    } catch (error) {
      if (!(error instanceof OpenworldTokenExpired)) throw error;
      tokens.discard(scope.liveKey, current);
      if (!retryExpired) throw error;
      const next = await credential();
      return work(next.origin, next.token, signal);
    }
  }

  return native;
}

export function createOpenworldTelemetry(options: OpenworldNativeOptions) {
  const { db, fetcher = fetch, now = Date.now } = options;
  const native = createOpenworldNativeConnection(options);
  const reads = sharedReads<Sample>(256, now, 1500);
  const skins = sharedReads<Uint8Array<ArrayBuffer>>(128, now, 1500);
  const recent = new Map<string, Sample & { persistedAt: number }>();

  async function save(scope: OpenworldScope, resource: SnapshotResource, sample: Sample) {
    const key = scope.binding + resource;
    const previous = recent.get(key);
    let persistedAt = previous?.persistedAt ?? 0;
    if (
      !previous ||
      sample.observedAt - persistedAt >= 15000 ||
      (resource === 'players' && rosterChanged(previous, sample))
    ) {
      await db.transaction().execute(async (tx) => {
        // Serialize competing bindings for this server. A waiting writer checks a
        // fresh statement snapshot after acquiring the row lock.
        await tx
          .selectFrom('managed_servers')
          .select('id')
          .where('id', '=', scope.serverId)
          .forUpdate()
          .executeTakeFirst();
        assertCurrentOpenworldScope(scope, await readOpenworldScope(tx, scope.serverId));
        await tx
          .insertInto('openworld_telemetry_snapshots')
          .values({
            server_id: scope.serverId,
            resource,
            binding: scope.binding,
            observed_at: new Date(sample.observedAt),
            data: JSON.stringify(sample.data),
          })
          .onConflict((c) =>
            c
              .columns(['server_id', 'resource'])
              .doUpdateSet((eb) => ({
                binding: eb.ref('excluded.binding'),
                observed_at: eb.ref('excluded.observed_at'),
                data: eb.ref('excluded.data'),
              }))
              .whereRef('openworld_telemetry_snapshots.observed_at', '<', 'excluded.observed_at'),
          )
          .execute();
      });
      persistedAt = sample.observedAt;
    } else {
      assertCurrentOpenworldScope(scope, await readOpenworldScope(db, scope.serverId));
    }
    if (recent.size >= 256 && !recent.has(key)) recent.delete(recent.keys().next().value as string);
    if ((recent.get(key)?.observedAt ?? -1) <= sample.observedAt)
      recent.set(key, { ...sample, persistedAt });
  }

  async function fallback<K extends Resource>(
    scope: OpenworldScope,
    resource: K,
    reason: OpenworldObservationReason,
  ): Promise<OpenworldObservation<K>> {
    if (resource !== 'player') {
      let sample: Sample | undefined = recent.get(scope.binding + resource);
      if (!sample) {
        const row = await db
          .selectFrom('openworld_telemetry_snapshots')
          .select(['data', 'observed_at'])
          .where('server_id', '=', scope.serverId)
          .where('resource', '=', resource as SnapshotResource)
          .where('binding', '=', scope.binding)
          .executeTakeFirst();
        if (row) {
          const parsed = openworldTelemetrySchemas[resource].safeParse(row.data);
          if (parsed.success) sample = { data: parsed.data, observedAt: row.observed_at.getTime() };
        }
      }
      if (sample)
        return {
          data: sample.data as OpenworldTelemetryData[K],
          source: 'snapshot',
          observedAt: new Date(sample.observedAt).toISOString(),
          reason,
        };
    }
    return { source: 'unavailable', data: null, observedAt: null, reason };
  }

  async function live(scope: OpenworldScope, resource: Resource, id?: number) {
    return reads.get(sampleKey(scope, resource, id), freshness[resource], async () => {
      const data = await native(scope, (origin, token, signal) =>
        readOpenworldTelemetry(origin, token, resource, signal, id, fetcher),
      );
      const sample = { data, observedAt: now() };
      if (resource !== 'player') await save(scope, resource, sample);
      else assertCurrentOpenworldScope(scope, await readOpenworldScope(db, scope.serverId));
      return sample;
    });
  }

  return {
    async read<K extends Resource>(
      who: AuthContext,
      serverId: string,
      resource: K,
      selected?: OpenworldPlayerSelection,
    ): Promise<OpenworldObservation<K>> {
      const reader = { who, resource };
      const scope = await readOpenworldScope(db, serverId, reader);
      if (scope.reason) return fallback(scope, resource, scope.reason);
      if (resource === 'player' && !selected) throw new DomainError('validation_failed');
      // A caller awaiting another viewer's in-flight read needs its own current grants.
      // An already completed cache hit used the current grant/binding query above.
      const cached = reads.completed(sampleKey(scope, resource, selected?.id));
      let sample: Sample;
      try {
        sample = await live(scope, resource, selected?.id);
      } catch (error) {
        if (
          !(
            error instanceof DomainError &&
            ['integration_unavailable', 'game_not_ready'].includes(error.code)
          )
        )
          throw error;
        const current = cached ? scope : await readOpenworldScope(db, serverId, reader);
        if (scope.binding !== current.binding) throw new DomainError('provenance_mismatch');
        return fallback(
          current,
          resource,
          current.reason ?? (error.code === 'game_not_ready' ? 'not_ready' : 'unreachable'),
        );
      }
      if (!cached) {
        const current = await readOpenworldScope(db, serverId, reader);
        if (scope.binding !== current.binding) throw new DomainError('provenance_mismatch');
        if (current.reason || current.liveKey !== scope.liveKey)
          return fallback(current, resource, current.reason ?? 'not_ready');
      }
      if (selected && resource === 'player')
        assertSelection(
          sample.data as OpenworldTelemetryData['player'],
          selected,
          sample.observedAt,
        );
      return {
        source: 'live',
        ...(resource === 'players' ? { processRef: openworldProcessRef(scope) } : {}),
        data: sample.data as OpenworldTelemetryData[K],
        observedAt: new Date(sample.observedAt).toISOString(),
        reason: null,
      };
    },
    async skin(
      who: AuthContext,
      serverId: string,
      selected: OpenworldPlayerSelection,
      view: 'head' | 'body',
      hash: string,
    ) {
      const reader = { who, resource: 'players' as const };
      const scope = await readOpenworldScope(db, serverId, reader);
      if (scope.reason) throw new DomainError('game_not_ready');
      const key = JSON.stringify([scope.liveKey, selected.id, selected.name, view, hash]);
      const cached = reads.completed(sampleKey(scope, 'players')) && skins.completed(key);
      const sample = await live(scope, 'players');
      const member = (sample.data as OpenworldTelemetryData['players']).players.find(
        (p) => p.id === selected.id,
      );
      assertSelection(member, selected, sample.observedAt);
      if (member?.skinHash !== hash) throw new DomainError('not_found');
      const image = await skins.get(key, 15000, () =>
        native(scope, (origin, token, signal) =>
          readOpenworldPlayerSkin(origin, token, selected.id, view, hash, signal, fetcher),
        ),
      );
      if (!cached)
        assertCurrentOpenworldScope(scope, await readOpenworldScope(db, serverId, reader));
      return image;
    },
  };
}
