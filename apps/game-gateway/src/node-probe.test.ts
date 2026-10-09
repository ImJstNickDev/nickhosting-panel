import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { probeNodeEndpoint, startNodeProbe } from './node-probe.js';

describe('private node path challenge', () => {
  it.each(['tcp', 'udp'] as const)(
    'requires an exact fresh nonce roundtrip over %s',
    async (transport) => {
      const server = await startNodeProbe({ address: '127.0.0.1', port: 0, transport });
      try {
        expect(await probeNodeEndpoint('127.0.0.1', server.port, transport, 500)).toBe(true);
        expect(await probeNodeEndpoint('127.0.0.2', server.port, transport, 100)).toBe(false);
      } finally {
        await server.close();
      }
      expect(await probeNodeEndpoint('127.0.0.1', server.port, transport, 100)).toBe(false);
    },
  );
  it('rejects unrelated TCP responses', async () => {
    const server = createServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', () => socket.end('unrelated'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture');
    try {
      expect(await probeNodeEndpoint('127.0.0.1', address.port, 'tcp', 100)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('rejects UDP send-only success and malformed replies', async () => {
    const socket = createSocket('udp4');
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    try {
      expect(await probeNodeEndpoint('127.0.0.1', socket.address().port, 'udp', 100)).toBe(false);
      socket.on('message', (_data, remote) =>
        socket.send(Buffer.alloc(64), remote.port, remote.address),
      );
      expect(await probeNodeEndpoint('127.0.0.1', socket.address().port, 'udp', 100)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  });
  it('never resolves arbitrary hostname inputs or accepts invalid endpoints', async () => {
    expect(await probeNodeEndpoint('example.invalid', 9000, 'tcp', 100)).toBe(false);
    expect(await probeNodeEndpoint('127.0.0.1', 0, 'tcp', 100)).toBe(false);
    await expect(startNodeProbe({ address: '0.0.0.0', port: 0, transport: 'tcp' })).rejects.toThrow(
      'configuration_invalid',
    );
  });
});
