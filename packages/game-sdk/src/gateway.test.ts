import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type GatewayRoute,
  gatewayObservationSchema,
  gatewayRouteSchema,
  gatewaySnapshotSchema,
  gatewayWakeRequestSchema,
} from './gateway.js';

const route: GatewayRoute = {
  id: randomUUID(),
  serverId: randomUUID(),
  nodeId: randomUUID(),
  allocationId: randomUUID(),
  generation: randomUUID(),
  revision: 1,
  public: { address: '203.0.113.5', port: 25565, transport: 'tcp' },
  backend: { allocationAddress: '127.0.0.1', address: '10.1.2.3', port: 25565 },
  mode: 'sleeping',
  locale: 'en',
};
const snapshot = {
  gatewayId: randomUUID(),
  revision: 1,
  issuedAt: '2026-10-09T12:00:00Z',
  expiresAt: '2026-10-09T12:00:15Z',
  routes: [route],
};
describe('strict Gateway control contracts', () => {
  it('preserves provider and effective addresses and equal numerical public/backend ports', () => {
    expect(gatewayRouteSchema.parse(route)).toEqual(route);
    expect(
      gatewayRouteSchema.parse({
        ...route,
        backend: { ...route.backend, allocationAddress: 'fd00::1', address: 'fd00::1' },
      }).backend.address,
    ).toBe('fd00::1');
  });
  it('rejects unknown privileged fields, invalid endpoint values and non-UUID ownership', () => {
    for (const invalid of [
      { ...route, apiKey: 'secret' },
      { ...route, allocationId: 1 },
      { ...route, serverId: 'direct-provider-name' },
      { ...route, public: { ...route.public, address: 'arbitrary-host.example' } },
      { ...route, public: { ...route.public, port: 0 } },
      { ...route, mode: 'container-running' },
    ])
      expect(gatewayRouteSchema.safeParse(invalid).success).toBe(false);
  });
  it('rejects duplicate route/endpoint registry entries and invalid lease intervals', () => {
    expect(gatewaySnapshotSchema.safeParse(snapshot).success).toBe(true);
    for (const invalid of [
      { ...snapshot, routes: [route, route] },
      { ...snapshot, routes: [route, { ...route, id: randomUUID() }] },
      { ...snapshot, expiresAt: snapshot.issuedAt },
    ])
      expect(gatewaySnapshotSchema.safeParse(invalid).success).toBe(false);
  });
  it('ties observations and wake requests to exact generation/revision identities', () => {
    expect(
      gatewayWakeRequestSchema.safeParse({
        routeId: route.id,
        routeRevision: 1,
        requestId: randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      gatewayObservationSchema.safeParse({
        routeId: route.id,
        routeRevision: 1,
        routes: [{ routeId: route.id, routeRevision: 1 }],
        generation: route.generation,
        observedAt: snapshot.issuedAt,
        ready: true,
        activeSessions: 0,
      }).success,
    ).toBe(true);
    expect(
      gatewayObservationSchema.safeParse({
        routeId: route.id,
        routeRevision: 1,
        observedAt: snapshot.issuedAt,
        ready: true,
        activeSessions: 0,
      }).success,
    ).toBe(false);
  });
  it('requires a nonempty unique complete observation route declaration matching its anchor', () => {
    const observation = {
      routeId: route.id,
      routeRevision: 1,
      generation: route.generation,
      observedAt: snapshot.issuedAt,
      ready: true,
      activeSessions: 0,
    };
    const member = { routeId: route.id, routeRevision: 1 };
    for (const routes of [
      undefined,
      [],
      [member, member],
      [{ routeId: randomUUID(), routeRevision: 1 }],
      [{ ...member, routeRevision: 2 }],
      [{ ...member, privateToken: 'unsupported' }],
    ])
      expect(gatewayObservationSchema.safeParse({ ...observation, routes }).success).toBe(false);
    expect(
      gatewayObservationSchema.safeParse({
        ...observation,
        routes: [member, { routeId: randomUUID(), routeRevision: 3 }],
      }).success,
    ).toBe(true);
  });
  it('permits ordinary idle samples but requires valid ready zero-session evidence for a quiescence promise', () => {
    const value = {
      routeId: route.id,
      routeRevision: 1,
      routes: [{ routeId: route.id, routeRevision: 1 }],
      generation: route.generation,
      observedAt: snapshot.issuedAt,
      ready: true,
      idle: true,
      playerCount: 0,
      activeSessions: 0,
    };
    expect(gatewayObservationSchema.safeParse(value).success).toBe(true);
    expect(
      gatewayObservationSchema.safeParse({ ...value, quiescenceUntil: snapshot.expiresAt }).success,
    ).toBe(true);
    for (const patch of [
      { ready: false },
      { idle: false },
      { activeSessions: 1 },
      { playerCount: 1 },
      { quiescenceUntil: snapshot.issuedAt },
    ])
      expect(
        gatewayObservationSchema.safeParse({
          ...value,
          quiescenceUntil: snapshot.expiresAt,
          ...patch,
        }).success,
      ).toBe(false);
  });
});
