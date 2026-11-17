import { DomainError, type SecretCodec } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { type GatewayRoute, gatewayOfflineApiRequestSchema } from '@nickhosting/game-sdk';
import { translate } from '@nickhosting/i18n';
import { gatewaySafetyContext, type ManagementRuntime } from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import type { SatisfactoryApi } from '../../../games/satisfactory/src/api.js';
import {
  handleNativeOfflineApi,
  supportsNativeOfflineOperation,
} from '../../../games/satisfactory/src/native-api.js';
import {
  mergeOfflineSnapshots,
  readOfflineSnapshots,
} from '../../../games/satisfactory/src/offline-snapshots.js';
import { readStoppedSatisfactoryCredentials } from '../../../packages/server-management/src/satisfactory-native-credentials.js';
import type { Variables } from './app.js';

const nameFor = (serverId: string) => `gateway.satisfactory.observations.${serverId}`;
const sessionObservations = new Map<string, { generation: string; at: number }>();
/** The existing online observation captures native read metadata even when no
 * player opens the relevant tab before idle suspension. Failure supplies no data
 * and cannot invalidate an independently successful player-count observation. */
export async function observeSatisfactorySessions(
  db: Kysely<Database>,
  codec: SecretCodec,
  route: GatewayRoute,
  api: SatisfactoryApi,
  revalidate: () => Promise<unknown>,
): Promise<void> {
  if (route.mode !== 'online') return;
  const previous = sessionObservations.get(route.serverId);
  if (previous?.generation === route.generation && Date.now() - previous.at < 30000) return;
  if (sessionObservations.size >= 1024) {
    const first = sessionObservations.keys().next().value;
    if (first) sessionObservations.delete(first);
  }
  sessionObservations.set(route.serverId, { generation: route.generation, at: Date.now() });
  try {
    const signal = AbortSignal.timeout(1500);
    const operations = [
      'EnumerateSessions',
      'GetServerOptions',
      'GetAdvancedGameSettings',
    ] as const;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => api.sessions(signal)),
      Promise.resolve().then(() => api.options(signal)),
      Promise.resolve().then(() => api.advancedSettings(signal)),
    ]);
    await revalidate();
    const observations = results.flatMap((result, index) =>
      result.status === 'fulfilled'
        ? [{ operation: operations[index] as string, body: { data: result.value } }]
        : [],
    );
    if (observations.length)
      await persistSatisfactoryOfflineSnapshots(db, codec, route.serverId, [], observations);
  } catch {
    /* No successful native observation: retain the last genuine snapshot. */
  }
}
export async function persistSatisfactoryOfflineSnapshots(
  db: Kysely<Database>,
  codec: SecretCodec,
  serverId: string,
  cache: unknown,
  nativeObservation?:
    | { operation: string; body: Record<string, unknown> }
    | Array<{ operation: string; body: Record<string, unknown> }>,
): Promise<void> {
  const name = nameFor(serverId);
  await db.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ${name}, 0))`.execute(
      transaction,
    );
    const old = await transaction
      .selectFrom('encrypted_secrets')
      .select('envelope')
      .where('name', '=', name)
      .executeTakeFirst();
    const next = mergeOfflineSnapshots(
      old ? JSON.parse(codec.decrypt(old.envelope, name)) : {},
      cache,
    );
    for (const entry of nativeObservation
      ? Array.isArray(nativeObservation)
        ? nativeObservation
        : [nativeObservation]
      : [])
      Object.assign(
        next,
        readOfflineSnapshots({ [entry.operation]: { observedAt: Date.now(), body: entry.body } }),
      );
    if (!Object.keys(next).length) return;
    const envelope = codec.encrypt(JSON.stringify(next), name);
    await transaction
      .insertInto('encrypted_secrets')
      .values({ name, envelope })
      .onConflict((conflict) => conflict.column('name').doUpdateSet({ envelope }))
      .execute();
  });
}
export function registerSatisfactoryOfflineApi(
  app: Hono<{ Variables: Variables }>,
  options: {
    db: Kysely<Database>;
    codec: SecretCodec;
    body: (c: Context) => Promise<unknown>;
    route: (input: unknown) => Promise<GatewayRoute>;
    management: () => Promise<ManagementRuntime>;
  },
): void {
  const { db, codec } = options;
  app.post('/internal/gateway/:gatewayId/offline-api', async (c) => {
    c.header('Cache-Control', 'no-store');
    const input = z
      .strictObject({
        routeId: z.uuid(),
        routeRevision: z.number().int().positive(),
        request: gatewayOfflineApiRequestSchema,
      })
      .safeParse(await options.body(c));
    if (!input.success) throw new DomainError('validation_failed');
    const routeInput = { routeId: input.data.routeId, routeRevision: input.data.routeRevision };
    const selected = await options.route(routeInput);
    await gatewaySafetyContext(db, selected);
    if (
      selected.protocol?.handlerId !== 'satisfactory' ||
      selected.protocol.role !== 'game' ||
      selected.public.transport !== 'tcp'
    )
      throw new DomainError('forbidden');
    if (
      selected.mode !== 'sleeping' ||
      selected.wakeEnabled === false ||
      !supportsNativeOfflineOperation(input.data.request.operation)
    )
      throw new DomainError('integration_unavailable');
    const management = await options.management();
    const confirmStopped = management.lifecycle.confirmInitialInstallationStopped;
    const authority = await readStoppedSatisfactoryCredentials(db, selected.serverId, {
      adapter: management.adapter,
      confirmStopped,
    });
    if (!authority || authority.generation !== selected.generation)
      throw new DomainError('integration_unavailable');
    const name = nameFor(selected.serverId);
    const stored = await db
      .selectFrom('encrypted_secrets')
      .select('envelope')
      .where('name', '=', name)
      .executeTakeFirst();
    let snapshots = readOfflineSnapshots(
      stored ? JSON.parse(codec.decrypt(stored.envelope, name)) : {},
    );
    // Upgrade observations from the existing private Gateway cache without
    // carrying over its old bearer-token-based authorization heuristic.
    if (!snapshots[input.data.request.operation]) {
      const cacheName = `gateway.satisfactory.cache.${selected.serverId}`;
      const cache = await db
        .selectFrom('encrypted_secrets')
        .select('envelope')
        .where('name', '=', cacheName)
        .executeTakeFirst();
      if (cache)
        snapshots = mergeOfflineSnapshots(
          snapshots,
          JSON.parse(codec.decrypt(cache.envelope, cacheName)),
        );
    }
    const result = handleNativeOfflineApi(
      authority.credentials,
      input.data.request,
      (operation) => {
        const body = snapshots[operation]?.body;
        if (!body || operation !== 'QueryServerState') return body;
        const data = body.data as { serverGameState: Record<string, unknown> };
        const state = data.serverGameState;
        return {
          data: {
            serverGameState: {
              ...state,
              numConnectedPlayers: 0,
              averageTickRate: 0,
              isGamePaused: true,
              activeSessionName: state.isGameRunning
                ? translate(selected.locale, 'gateway.satisfactory.sleepingSession', {
                    name: String(state.activeSessionName),
                  })
                : state.activeSessionName,
            },
          },
        };
      },
    );
    const current = await options.route(routeInput);
    if (
      current.mode !== 'sleeping' ||
      current.wakeEnabled === false ||
      current.generation !== authority.generation
    )
      throw new DomainError('integration_unavailable');
    return c.json(result);
  });
}
