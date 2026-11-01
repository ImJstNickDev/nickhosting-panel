import { createServer } from 'node:https';
import { beforeAll, expect, it, vi } from 'vitest';
import { satisfactoryPinnedTransport } from './satisfactory-api.js';
import {
  generateSatisfactoryTlsIdentity,
  type SatisfactoryTlsIdentity,
} from './satisfactory-tls.js';

let identity: SatisfactoryTlsIdentity, other: SatisfactoryTlsIdentity;
beforeAll(async () => {
  identity = await generateSatisfactoryTlsIdentity('11111111-1111-4111-8111-111111111111');
  other = await generateSatisfactoryTlsIdentity('22222222-2222-4222-8222-222222222222');
});
it('authenticates only to the pinned server despite its per-server certificate hostname', async () => {
  let authorization: unknown;
  const server = createServer(
    { key: identity.privateKeyPem, cert: identity.certificatePem },
    (req, res) => {
      authorization = req.headers.authorization;
      req.resume();
      req.on('end', () => {
        res.writeHead(200);
        res.end('{"data":{"health":"healthy","serverCustomData":""}}');
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  try {
    expect(
      await satisfactoryPinnedTransport(
        { address: '127.0.0.1', port: address.port },
        identity.certificatePem,
        'secret',
      ).request({ function: 'HealthCheck' }),
    ).toEqual({ data: { health: 'healthy', serverCustomData: '' } });
    expect(authorization).toBe('Bearer secret');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('does not transmit the token or request to a different certificate', async () => {
  const received = vi.fn();
  const server = createServer({ key: other.privateKeyPem, cert: other.certificatePem }, received);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  try {
    await expect(
      satisfactoryPinnedTransport(
        { address: '127.0.0.1', port: address.port },
        identity.certificatePem,
        'secret',
      ).request({ function: 'HealthCheck' }),
    ).rejects.toThrow();
    expect(received).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('rejects non-IP backend destinations and unsafe authorization headers', () => {
  expect(() =>
    satisfactoryPinnedTransport(
      { address: 'example.com', port: 7777 },
      identity.certificatePem,
      'secret',
    ),
  ).toThrow();
  expect(() =>
    satisfactoryPinnedTransport(
      { address: '127.0.0.1', port: 7777 },
      identity.certificatePem,
      'secret\r\nX: injected',
    ),
  ).toThrow();
});
