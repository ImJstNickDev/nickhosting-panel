import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import type { GatewayProtocolContext } from '@nickhosting/game-sdk';
import { describe, expect, it } from 'vitest';
import {
  observeOpenworld,
  openworldGatewayAdapter,
  openworldStatusRequest,
  readOpenworldStatus,
} from './gateway-module.js';

function reply(nonce: Buffer, version = 'a1.2.9') {
  const prefix = Buffer.alloc(40);
  prefix[16] = 8;
  prefix.write('OWMU', 17);
  nonce.copy(prefix, 21);
  prefix[25] = 1;
  prefix.writeUInt16LE(2, 26);
  prefix.writeUInt16LE(12, 28);
  return Buffer.concat([
    prefix,
    Buffer.from([3]),
    Buffer.from('QA!'),
    Buffer.from([0, 0, version.length]),
    Buffer.from(version),
  ]);
}

function context(port: number, signal = new AbortController().signal): GatewayProtocolContext {
  return {
    route: {
      id: 'route',
      serverId: 'qa',
      nodeId: 'node',
      allocationId: 'allocation',
      revision: 1,
      generation: 'generation',
      public: { transport: 'udp', address: '127.0.0.2', port },
      backend: { address: '127.0.0.1', allocationAddress: '127.0.0.1', port },
      protocol: { handlerId: 'openworld', role: 'game', gameVersion: 'a1.2.9' },
      mode: 'online',
      locale: 'en',
    },
    signal,
  };
}

describe('Openworld a1.2.9 server info', () => {
  it('identifies metadata and icon queries independently of a join', () => {
    const request = openworldStatusRequest(Buffer.from('abcd'));
    expect(request.length).toBe(1040);
    expect(request.readUInt16LE(26)).toBe(0xffff);
    expect(openworldGatewayAdapter.classify(request, context(10000)).kind).toBe('status');
    request.writeUInt16LE(2, 26);
    expect(openworldGatewayAdapter.isStatusDatagram?.(request, 'client')).toBe(true);
    const join = request.subarray(0, 58);
    join[16] = 1;
    expect(openworldGatewayAdapter.classify(join, context(10000)).kind).toBe('ignore');
    expect(openworldGatewayAdapter.response(context(10000), 'sleeping')).toBeUndefined();
  });
  it('validates packet bounds, player counts and the echoed query id', () => {
    const id = Buffer.from('abcd');
    const bytes = reply(id);
    expect(readOpenworldStatus(bytes, id)).toEqual({
      name: 'QA!',
      description: '',
      version: 'a1.2.9',
      players: 2,
      slots: 12,
    });
    expect(readOpenworldStatus(bytes, Buffer.alloc(4))).toBeUndefined();
    expect(readOpenworldStatus(bytes.subarray(0, bytes.length - 1), id)).toBeUndefined();
    bytes.writeUInt16LE(13, 26);
    expect(readOpenworldStatus(bytes, id)).toBeUndefined();
  });
  it('samples the assigned UDP backend, with no administrative listener or sleep decision', async () => {
    const backend = createSocket('udp4');
    backend.bind(0, '127.0.0.1');
    await once(backend, 'listening');
    try {
      backend.on('message', (query, remote) => {
        const nonce = query.subarray(22, 26);
        backend.send(reply(Buffer.alloc(4)), remote.port, remote.address);
        backend.send(reply(nonce, 'a1.2.8'), remote.port, remote.address);
        backend.send(reply(nonce), remote.port, remote.address);
      });
      expect(await observeOpenworld(context(backend.address().port))).toEqual({
        ready: true,
        playerCount: 2,
      });
      const next = context(backend.address().port);
      expect(
        await observeOpenworld({
          ...next,
          route: {
            ...next.route,
            protocol: { handlerId: 'openworld', gameVersion: 'a1.2.10', role: 'game' },
          },
        }),
      ).toEqual({ ready: false });
      const controller = new AbortController();
      const pending = observeOpenworld(context(backend.address().port, controller.signal));
      controller.abort();
      expect(await pending).toEqual({ ready: false });
    } finally {
      backend.close();
    }
  });
});
