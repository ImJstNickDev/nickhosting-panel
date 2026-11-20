import { randomUUID } from 'node:crypto';
import type { GatewayRoute } from '@nickhosting/game-sdk';
import { expect, it } from 'vitest';
import { createEvidenceCache } from './evidence.js';

it('shares an exact revision-bound envelope without extending its source age or accepting partial contexts', () => {
  let now = 1800000000000;
  const route: GatewayRoute = {
    id: randomUUID(),
    serverId: randomUUID(),
    nodeId: randomUUID(),
    allocationId: randomUUID(),
    revision: 1,
    generation: randomUUID(),
    public: { address: '127.0.0.1', port: 25565, transport: 'tcp' },
    backend: { allocationAddress: '10.0.0.1', address: '10.0.0.1', port: 25565 },
    mode: 'online',
    locale: 'en',
  };
  const context = {
    providerServerId: 1,
    providerServerUuid: randomUUID(),
    externalId: 'owned',
    providerUserId: 1,
    providerNodeId: 1,
    providerAllocationId: 1,
    nestId: 1,
    eggId: 1,
  };
  const input = {
    observedAt: now - 100,
    configuration: {},
    snapshot: {
      gatewayId: randomUUID(),
      revision: 1,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 15000).toISOString(),
      routes: [route],
    },
    contexts: [{ routeId: route.id, routeRevision: 1, context, proof: null }],
    nodes: [{ id: 1, uuid: randomUUID() }],
    allocations: [{ nodeId: 1, allocations: [] }],
    servers: [
      {
        id: 1,
        uuid: context.providerServerUuid,
        external_id: 'owned',
        user: 1,
        node: 1,
        nest: 1,
        egg: 1,
        suspended: false,
      },
    ],
  };
  const cache = createEvidenceCache(1000, () => now);
  cache.replace(input);
  expect(cache.route(route)?.context).toEqual(context);
  expect(cache.server(1)).toEqual(input.servers[0]);
  expect(cache.allocations(1)).toEqual([]);
  expect(cache.serversForRoutes([route.id, route.id])).toEqual(input.servers);
  expect(cache.serversForRoutes([route.id, randomUUID()])).toBeUndefined();
  expect(cache.route({ ...route, revision: 2 })).toBeUndefined();
  expect(cache.route({ ...route, generation: randomUUID() })).toBeUndefined();
  expect(() => cache.replace({ ...input, contexts: [] })).toThrow();
  expect(() =>
    cache.replace({ ...input, contexts: [...input.contexts, ...input.contexts] }),
  ).toThrow();
  now += 901;
  expect(cache.server(1)).toBeUndefined();
  expect(cache.allocations(1)).toBeUndefined();
  expect(cache.serversForRoutes([route.id])).toBeUndefined();
  expect(cache.current()).toBeUndefined();
  expect(cache.route(route)).toBeUndefined();
  expect(() => cache.replace(input)).toThrow();
});
