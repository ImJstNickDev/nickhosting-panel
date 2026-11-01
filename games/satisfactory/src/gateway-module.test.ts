import type { GatewayProtocolContext } from '@nickhosting/game-sdk';
import { describe, expect, it } from 'vitest';
import { createSatisfactoryGatewayAdapter } from './gateway-module.js';
import { decodeSatisfactoryState, encodeSatisfactoryPoll } from './protocol.js';

const persisted = {
  state: 3 as const,
  netCL: 12345,
  flags: '1',
  substates: [{ id: 0, version: 9 }],
  name: 'Factory',
  observedAt: '2026-11-01T00:00:00Z',
};
function context(input: Uint8Array): GatewayProtocolContext {
  return {
    signal: new AbortController().signal,
    input,
    route: {
      id: '11111111-1111-4111-8111-111111111111',
      serverId: '22222222-2222-4222-8222-222222222222',
      nodeId: '33333333-3333-4333-8333-333333333333',
      allocationId: '44444444-4444-4444-8444-444444444444',
      revision: 1,
      generation: '55555555-5555-4555-8555-555555555555',
      public: { address: '127.0.0.1', port: 7777, transport: 'udp' },
      backend: { address: '127.0.0.2', allocationAddress: '127.0.0.2', port: 7777 },
      protocol: {
        handlerId: 'satisfactory',
        gameVersion: 'public',
        role: 'game',
        satisfactory: persisted,
      },
      mode: 'sleeping',
      locale: 'en',
    },
  };
}
describe('Satisfactory gateway', () => {
  const adapter = createSatisfactoryGatewayAdapter({ read: () => undefined, write: () => {} });
  it('echoes each request cookie from persistent metadata after a restart without waking', () => {
    for (const cookie of [0n, 42n, 0xffffffffffffffffn]) {
      const c = context(encodeSatisfactoryPoll(cookie));
      expect(adapter.classify(c.input ?? new Uint8Array(), c)).toEqual({ kind: 'status' });
      const response = adapter.response(c, 'sleeping');
      expect(response).toBeDefined();
      expect(decodeSatisfactoryState(response ?? new Uint8Array(), cookie)).toEqual({
        cookie,
        state: 0,
        netCL: 12345,
        flags: 1n,
        substates: [{ id: 0, version: 9 }],
        name: 'Factory',
      });
    }
  });
  it('reports loading only during wake and never fabricates a NetCL without cached state', () => {
    const c = context(encodeSatisfactoryPoll(1n));
    expect(decodeSatisfactoryState(adapter.response(c, 'waking') ?? new Uint8Array()).state).toBe(
      2,
    );
    delete c.route.protocol?.satisfactory;
    expect(adapter.response(c, 'sleeping')).toBeUndefined();
  });
  it('does not treat arbitrary gameplay or TLS bytes as authenticated join intent', () => {
    const c = context(new Uint8Array([1, 2, 3]));
    expect(adapter.classify(c.input ?? new Uint8Array(), c)).toEqual({ kind: 'ignore' });
  });
});
