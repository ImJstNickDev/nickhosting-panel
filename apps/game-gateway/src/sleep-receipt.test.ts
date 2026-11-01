import { randomUUID } from 'node:crypto';
import type { GatewaySnapshot } from '@nickhosting/game-sdk';
import { describe, expect, it } from 'vitest';
import { type SleepFence, sleepReceipt } from './sleep-receipt.js';

const now = Date.now();
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}
function fixture() {
  const current: GatewaySnapshot = {
    gatewayId: randomUUID(),
    revision: 2,
    issuedAt: new Date(now - 500).toISOString(),
    expiresAt: new Date(now + 5000).toISOString(),
    routes: [
      {
        id: randomUUID(),
        serverId: randomUUID(),
        nodeId: randomUUID(),
        allocationId: randomUUID(),
        generation: randomUUID(),
        revision: 2,
        mode: 'blocked',
        locale: 'en',
        wakeJobId: randomUUID(),
        public: { address: '127.0.0.1', port: 28000, transport: 'tcp' },
        backend: { allocationAddress: '127.0.0.1', address: '172.20.0.1', port: 28000 },
      },
    ],
  };
  const r = required(current.routes[0]);
  const fence: SleepFence = {
    deadline: now + 4000,
    observedAt: now - 1000,
    generation: r.generation,
    routes: [{ ...structuredClone(r), mode: 'online', revision: 1 }],
  };
  const receipt = structuredClone(current);
  receipt.revision = 3;
  receipt.issuedAt = new Date(now).toISOString();
  receipt.expiresAt = new Date(now + 30000).toISOString();
  Object.assign(required(receipt.routes[0]), {
    revision: 3,
    mode: 'sleeping',
    wakeJobId: undefined,
    completedSleep: {
      jobId: randomUUID(),
      generation: r.generation,
      quiescenceUntil: new Date(fence.deadline).toISOString(),
      completedAt: new Date(now - 10).toISOString(),
    },
  });
  return { current, receipt, fence, serverId: r.serverId };
}
describe('durable sleep receipt', () => {
  it('releases only exact completion and caps authority at the original fence', () => {
    const f = fixture();
    expect(sleepReceipt(f.current, f.receipt, f.serverId, f.fence, now, 100)).toEqual({
      ...f.receipt,
      expiresAt: new Date(f.fence.deadline).toISOString(),
    });
  });
  it.each([
    'backend',
    'public',
    'generation',
    'node',
    'allocation',
    'mode',
    'wake',
    'revision',
    'missing-proof',
    'wrong-fence',
    'old-completion',
    'future-completion',
    'future-snapshot',
    'expired',
    'missing-role',
    'extra-role',
    'locale',
  ])('rejects %s', (change) => {
    const f = fixture();
    const r = required(f.receipt.routes[0]);
    switch (change) {
      case 'backend':
        r.backend.port++;
        break;
      case 'public':
        r.public.port++;
        break;
      case 'generation':
        r.generation = randomUUID();
        break;
      case 'node':
        r.nodeId = randomUUID();
        break;
      case 'allocation':
        r.allocationId = randomUUID();
        break;
      case 'mode':
        r.mode = 'manually_stopped';
        break;
      case 'wake':
        r.wakeJobId = randomUUID();
        break;
      case 'revision':
        r.revision = 2;
        break;
      case 'missing-proof':
        delete r.completedSleep;
        break;
      case 'wrong-fence':
        required(r.completedSleep).quiescenceUntil = new Date(now + 3999).toISOString();
        break;
      case 'old-completion':
        required(r.completedSleep).completedAt = new Date(now - 2000).toISOString();
        break;
      case 'future-completion':
        required(r.completedSleep).completedAt = new Date(now + 1).toISOString();
        break;
      case 'future-snapshot':
        f.receipt.issuedAt = new Date(now + 101).toISOString();
        break;
      case 'expired':
        f.fence.deadline = now;
        break;
      case 'missing-role':
        f.receipt.routes = [];
        break;
      case 'extra-role':
        f.receipt.routes.push({ ...r, id: randomUUID() });
        break;
      case 'locale':
        r.locale = 'it';
        break;
    }
    expect(sleepReceipt(f.current, f.receipt, f.serverId, f.fence, now, 100)).toBeUndefined();
  });
  it('rejects mismatched completion across multiple roles', () => {
    const f = fixture();
    const second = { ...structuredClone(required(f.current.routes[0])), id: randomUUID() };
    f.current.routes.push(second);
    f.fence.routes.push({ ...second, mode: 'online', revision: 1 });
    f.receipt.routes.push({
      ...structuredClone(required(f.receipt.routes[0])),
      id: second.id,
      completedSleep: {
        ...required(required(f.receipt.routes[0]).completedSleep),
        jobId: randomUUID(),
      },
    });
    expect(sleepReceipt(f.current, f.receipt, f.serverId, f.fence, now, 100)).toBeUndefined();
  });
});
