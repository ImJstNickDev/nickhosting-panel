import { createHash, timingSafeEqual } from 'node:crypto';
import { type AuthContext, DomainError, type SecretCodec } from '@nickhosting/core';
import { type createDatabase, getSecret, getSettings } from '@nickhosting/database';
import { gatewayObservationSchema, gatewayWakeRequestSchema } from '@nickhosting/game-sdk';
import { gatewayReachabilityProofSchema } from '@nickhosting/gateway-safety';
import {
  authorizeServer,
  gatewayConfiguration,
  gatewaySafetyContext,
  getGatewaySnapshot,
  getGatewayState,
  listGatewayRoutes,
  type ManagementRuntime,
  recordGatewayContact,
  reportGatewayObservation,
  requestGatewayWake,
  requireGatewayRoute,
  setGatewayPolicy,
  setGatewayRoute,
  verifyManagedIdentity,
} from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from './app.js';

const routeRequest = z
  .object({ routeId: z.uuid(), routeRevision: z.number().int().positive().optional() })
  .strict();
const hash = (text: string) => createHash('sha256').update(text).digest();
export function registerGatewayRoutes(
  app: Hono<{ Variables: Variables }>,
  options: {
    db: ReturnType<typeof createDatabase>['db'];
    env: Readonly<Record<string, string | undefined>>;
    codec: SecretCodec;
    principal: (
      c: Context<{ Variables: Variables }>,
      regularOnly?: boolean,
    ) => Promise<AuthContext>;
    body: (c: Context) => Promise<unknown>;
    management: () => Promise<ManagementRuntime>;
  },
) {
  const { db, env, codec } = options;
  const route = async (input: unknown) => {
    const value = routeRequest.safeParse(input);
    if (!value.success) throw new DomainError('validation_failed');
    return requireGatewayRoute(db, value.data.routeId, value.data.routeRevision, env, {
      revisionPrecondition: true,
    });
  };
  app.use('/internal/gateway/*', async (c, next) => {
    // Browser sessions/support tokens are never service authentication. Constant
    // length digests avoid leaking the dedicated secret; no provider key is used.
    const config = await getSettings(db, env),
      token = await getSecret(db, codec, 'gatewayControlToken', env);
    const authorization = c.req.header('authorization') ?? '';
    const match = /^\/internal\/gateway\/([0-9a-f-]{36})\/[a-z-]+$/.exec(c.req.path);
    if (
      !config.values.gatewayEnabled ||
      !match ||
      match[1] !== config.values.gatewayId ||
      !token ||
      !/^[A-Za-z0-9_-]{43,512}$/.test(token) ||
      authorization.length > 1024 ||
      !timingSafeEqual(hash(authorization), hash(`Bearer ${token}`)) ||
      c.req.header('x-nh-support-token')
    )
      throw new DomainError('unauthenticated');
    await next();
    if (c.res.status < 400) {
      // Diagnostic contact only; absence of a receipt must never invalidate a
      // completed control-plane action or manufacture listener readiness.
      await recordGatewayContact(db, match[1] ?? '').catch(() => {});
    }
  });
  const prefix = '/internal/gateway/:gatewayId';
  app.get(`${prefix}/configuration`, async (c) => {
    const values = await gatewayConfiguration(db, env);
    return c.json(
      Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('gateway'))),
    );
  });
  app.get(`${prefix}/snapshot`, async (c) => c.json(await getGatewaySnapshot(db, env)));
  app.post(`${prefix}/wake`, async (c) => {
    const value = gatewayWakeRequestSchema.safeParse(await options.body(c));
    if (!value.success) throw new DomainError('validation_failed');
    const selected = await requireGatewayRoute(
      db,
      value.data.routeId,
      value.data.routeRevision,
      env,
    );
    const management = await options.management();
    await management.refreshObservations();
    const state = await requestGatewayWake(
      db,
      selected.serverId,
      { generation: selected.generation, intent: 'join' },
      { env },
    );
    return c.json({
      mode: state.state,
      ...(state.wakeJobId ? { operationId: state.wakeJobId } : {}),
      ...(state.errorCode ? { reasonKey: `errors.${state.errorCode}` } : {}),
    });
  });
  app.post(`${prefix}/observations`, async (c) => {
    const parsed = gatewayObservationSchema.safeParse(await options.body(c));
    if (!parsed.success) throw new DomainError('validation_failed');
    const value = parsed.data;
    const snapshot = await getGatewaySnapshot(db, env);
    const selected = snapshot.routes.find((route) => route.id === value.routeId);
    if (
      !selected ||
      selected.revision !== value.routeRevision ||
      value.generation !== selected.generation ||
      value.wakeJobId !== selected.wakeJobId
    )
      throw new DomainError('conflict');
    const expected = snapshot.routes.filter((route) => route.serverId === selected.serverId);
    const matches = (rows: { id: string; revision: number | string }[]) =>
      rows.length === value.routes.length &&
      rows.every((route) =>
        value.routes.some(
          (observed) =>
            observed.routeId === route.id && observed.routeRevision === Number(route.revision),
        ),
      );
    if (!matches(expected)) throw new DomainError('conflict');
    const management = await options.management();
    const started = await management.lifecycle.observeProcessStart(selected.serverId, db);
    await reportGatewayObservation(
      db,
      selected.serverId,
      {
        generation: value.generation,
        wakeJobId: value.wakeJobId ?? null,
        observedAt: value.observedAt,
        processStartedAt: started,
        ready: value.ready,
        ...(value.idle === undefined ? {} : { idle: value.idle }),
        ...(value.playerCount === undefined ? {} : { playerCount: value.playerCount }),
        activeSessions: value.activeSessions,
        ...(value.quiescenceUntil ? { quiescenceUntil: value.quiescenceUntil } : {}),
      },
      {
        env,
        validateObservation: async (tx) => {
          // The provider probe above may wait. Serialize this final membership
          // check with route changes so one omitted/new role cannot claim readiness.
          const current = await tx
            .selectFrom('gateway_routes')
            .select(['id', 'revision', 'lease_expires_at'])
            .where('gateway_id', '=', snapshot.gatewayId)
            .where('server_id', '=', selected.serverId)
            .where('enabled', '=', true)
            .execute();
          if (!matches(current)) throw new DomainError('conflict');
          if (value.quiescenceUntil) {
            const deadline = Date.parse(value.quiescenceUntil);
            if (
              deadline <= Date.now() ||
              deadline > Date.parse(value.observedAt) + 30000 ||
              current.some(
                (route) =>
                  !route.lease_expires_at || deadline > route.lease_expires_at.getTime() - 1000,
              )
            )
              throw new DomainError('conflict');
          }
        },
      },
    );
    return c.body(null, 204);
  });
  app.post(`${prefix}/context`, async (c) =>
    c.json(await gatewaySafetyContext(db, await route(await options.body(c)))),
  );
  app.post(`${prefix}/inventory`, async (c) => {
    const parsed = z
      .discriminatedUnion('operation', [
        z.object({ operation: z.literal('nodes') }).strict(),
        z
          .object({ operation: z.literal('allocations'), nodeId: z.number().int().positive() })
          .strict(),
        z.object({ operation: z.literal('server'), routeId: z.uuid() }).strict(),
      ])
      .safeParse(await options.body(c));
    if (!parsed.success) throw new DomainError('validation_failed');
    const management = await options.management(),
      value = parsed.data;
    if (value.operation === 'nodes')
      return c.json(
        (await management.adapter.listNodes()).map((n) => ({ id: n.id, uuid: n.uuid })),
      );
    if (value.operation === 'allocations') {
      if (!(await management.adapter.listNodes()).some((n) => n.id === value.nodeId))
        throw new DomainError('not_found');
      return c.json(
        (await management.adapter.listAllocations(value.nodeId)).map((a) => ({
          id: a.id,
          ip: a.ip,
          port: a.port,
          assigned: a.assigned,
        })),
      );
    }
    const selected = await requireGatewayRoute(db, value.routeId, undefined, env);
    const context = await gatewaySafetyContext(db, selected);
    const server = await db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', selected.serverId)
      .executeTakeFirstOrThrow();
    const remote = await management.adapter.getApplicationServer(context.providerServerId);
    await verifyManagedIdentity(db, server, remote);
    return c.json({
      id: remote.id,
      uuid: remote.uuid,
      external_id: remote.external_id,
      user: remote.user,
      node: remote.node,
      nest: remote.nest,
      egg: remote.egg,
      suspended: remote.suspended,
      relationships: {
        allocations: {
          object: 'list' as const,
          data: (remote.relationships?.allocations?.data ?? []).map(({ attributes: a }) => ({
            attributes: { id: a.id, ip: a.ip, port: a.port, assigned: a.assigned },
          })),
        },
      },
    });
  });
  app.post(`${prefix}/proof-read`, async (c) => {
    const selected = await route(await options.body(c));
    const value = await db
      .selectFrom('gateway_reachability_proofs')
      .select('proof')
      .where('route_id', '=', selected.id)
      .executeTakeFirst();
    return c.json(value?.proof ?? null);
  });
  app.post(`${prefix}/proof-write`, async (c) => {
    const value = z
      .object({
        routeId: z.uuid(),
        routeRevision: z.number().int().positive(),
        proof: gatewayReachabilityProofSchema,
      })
      .strict()
      .safeParse(await options.body(c));
    if (!value.success) throw new DomainError('validation_failed');
    const selected = await route({
        routeId: value.data.routeId,
        routeRevision: value.data.routeRevision,
      }),
      proof = value.data.proof;
    if (
      proof.routeId !== selected.id ||
      proof.serverId !== selected.serverId ||
      proof.allocationId !== selected.allocationId ||
      proof.verifiedAt > Date.now() ||
      Date.now() - proof.verifiedAt > 30000
    )
      throw new DomainError('conflict');
    await db
      .insertInto('gateway_reachability_proofs')
      .values({ route_id: selected.id, proof: JSON.stringify(proof) })
      .onConflict((k) =>
        k.column('route_id').doUpdateSet({ proof: JSON.stringify(proof), updated_at: new Date() }),
      )
      .execute();
    return c.body(null, 204);
  });
  app.get('/v1/owner/gateway/routes', async (c) =>
    c.json(await listGatewayRoutes(db, await options.principal(c, true))),
  );
  app.put('/v1/owner/gateway/routes', async (c) =>
    c.json(await setGatewayRoute(db, await options.principal(c, true), await options.body(c), env)),
  );
  app.get('/v1/servers/:id/gateway', async (c) => {
    await authorizeServer(db, await options.principal(c), c.req.param('id'), 'server:read');
    return c.json(await getGatewayState(db, c.req.param('id'), { env }));
  });
  app.put('/v1/servers/:id/gateway', async (c) =>
    c.json(
      await setGatewayPolicy(
        db,
        await options.principal(c, true),
        c.req.param('id'),
        await options.body(c),
        { env, initializeOnly: c.req.header('if-none-match') === '*' },
      ),
    ),
  );
}
