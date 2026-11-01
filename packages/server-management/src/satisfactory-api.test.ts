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

it('binds native Administrator verification to the caller player and requires a native 204', async () => {
  let received: unknown;
  const playerId = '060102030405060708';
  const server = createServer(
    { key: identity.privateKeyPem, cert: identity.certificatePem },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          bearer: req.headers.authorization,
          playerId: req.headers['x-factorygame-playerid'],
          body: JSON.parse(Buffer.concat(chunks).toString()),
        };
        res.writeHead(204);
        res.end();
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  try {
    const { SatisfactoryApi } = await import('../../../games/satisfactory/src/api.js');
    const api = new SatisfactoryApi(
      satisfactoryPinnedTransport(
        { address: '127.0.0.1', port: address.port },
        identity.certificatePem,
        'original-player-token',
        playerId,
      ),
    );
    expect(await api.verifyConsoleAdministrator('AB'.repeat(64))).toBe(true);
    expect(received).toEqual({
      bearer: 'Bearer original-player-token',
      playerId,
      body: {
        function: 'VerifyAuthenticationToken',
        data: { AuthenticationToken: 'AB'.repeat(64), PrivilegeLevel: 'Administrator' },
      },
    });
    expect(
      await new SatisfactoryApi({ request: async () => ({ data: {} }) }).verifyConsoleAdministrator(
        'AB'.repeat(64),
      ),
    ).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
