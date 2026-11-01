import { randomUUID } from 'node:crypto';
import type { GatewaySnapshot } from '@nickhosting/game-sdk';
import { describe, expect, it } from 'vitest';
import { readinessReceipt } from './readiness-receipt.js';

const now = Date.now();
function fixture() {
  const current: GatewaySnapshot = {
    gatewayId: randomUUID(),
    revision: 1,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 4000).toISOString(),
    routes: [
      {
        id: randomUUID(),
        serverId: randomUUID(),
        nodeId: randomUUID(),
        allocationId: randomUUID(),
        revision: 1,
        generation: randomUUID(),
        wakeJobId: randomUUID(),
        mode: 'waking',
        locale: 'en',
        public: { address: '127.0.0.1', port: 28000, transport: 'tcp' },
        backend: { allocationAddress: '127.0.0.1', address: '172.20.0.1', port: 28000 },
      },
    ],
  };
  const receipt = structuredClone(current);
  receipt.revision = 2;
  receipt.issuedAt = new Date(now).toISOString();
  receipt.expiresAt = new Date(now + 30000).toISOString();
  const first = receipt.routes[0];
  if (!first) throw new Error('Missing fixture');
  first.mode = 'online';
  first.revision = 2;
  return { current, receipt, serverId: first.serverId };
}
describe('readiness receipt authority', () => {
  it('only advances same-process state and never extends the original lease', () => {
    const { current, receipt, serverId } = fixture();
    expect(readinessReceipt(current, current, receipt, serverId, now, 1000)).toEqual({
      ...receipt,
      expiresAt: current.expiresAt,
    });
  });
  it.each([
    'backend',
    'public',
    'generation',
    'job',
    'node',
    'allocation',
    'mode',
    'stale',
    'no-revision',
    'expired',
    'extra-role',
    'other-server',
    'future',
  ])('rejects %s authority changes', (change) => {
    const { current, receipt, serverId } = fixture();
    const route = receipt.routes[0];
    if (!route) throw new Error('Missing fixture');
    switch (change) {
      case 'backend':
        route.backend.port++;
        break;
      case 'public':
        route.public.port++;
        break;
      case 'generation':
        route.generation = randomUUID();
        break;
      case 'job':
        route.wakeJobId = randomUUID();
        break;
      case 'node':
        route.nodeId = randomUUID();
        break;
      case 'allocation':
        route.allocationId = randomUUID();
        break;
      case 'mode':
        route.mode = 'blocked';
        break;
      case 'stale':
        receipt.revision = 1;
        break;
      case 'no-revision':
        route.revision = 1;
        break;
      case 'expired':
        current.expiresAt = new Date(now).toISOString();
        break;
      case 'future':
        receipt.issuedAt = new Date(now + 2000).toISOString();
        break;
      case 'extra-role':
        receipt.routes.push({
          ...route,
          id: randomUUID(),
          public: { ...route.public, port: 28001 },
        });
        break;
      case 'other-server':
        route.serverId = randomUUID();
        break;
    }
    expect(readinessReceipt(current, current, receipt, serverId, now, 1000)).toBeUndefined();
  });
});

it('rejects a changed current authority and caps an equivalent renewal at the observed lease', () => {
  const { current, receipt, serverId } = fixture();
  const renewed = structuredClone(current);
  renewed.expiresAt = new Date(now + 20000).toISOString();
  expect(readinessReceipt(renewed, current, receipt, serverId, now, 1000)?.expiresAt).toBe(
    current.expiresAt,
  );
  renewed.revision++;
  expect(readinessReceipt(renewed, current, receipt, serverId, now, 1000)).toBeUndefined();
});
