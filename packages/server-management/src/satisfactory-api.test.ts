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
it('accepts empty 202 map-change acknowledgements without treating them as verified authentication', async () => {
  const server = createServer(
    { key: identity.privateKeyPem, cert: identity.certificatePem },
    (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(202);
        res.end();
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
      ).request({ function: 'LoadGame', data: { SaveName: 'Factory' } }),
    ).toEqual({});
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('streams authenticated save headers across pinned TLS before the native response is complete', async () => {
  const { SatisfactoryApi } = await import('../../../games/satisfactory/src/api.js');
  const save = {
    saveVersion: 1,
    buildVersion: 123,
    saveName: 'save',
    mapName: 'Persistent_Level',
    mapOptions: 'x'.repeat(16384),
    sessionName: 'Factory',
    playDurationSeconds: 1,
    saveDateTime: '2026-11-02T00:00:00Z',
    isModdedSave: false,
    isEditedSave: false,
    isCreativeModeEnabled: false,
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  let authorization: string | undefined;
  const server = createServer(
    { key: identity.privateKeyPem, cert: identity.certificatePem },
    (req, res) => {
      authorization = req.headers.authorization;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(
          `{"data":{"sessions":[{"sessionName":"Factory","saveHeaders":[${JSON.stringify(save)}`,
        );
        void gate.then(() => {
          finished = true;
          res.end(
            `,${Array.from({ length: 5 }, () => JSON.stringify(save)).join(',')}]}],"currentSessionIndex":0}}`,
          );
        });
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  try {
    const api = new SatisfactoryApi(
      satisfactoryPinnedTransport(
        { address: '127.0.0.1', port: address.port },
        identity.certificatePem,
        'private-token',
      ),
    );
    const events = api.streamSessions();
    expect((await events.next()).value).toMatchObject({ type: 'session', sessionName: 'Factory' });
    expect((await events.next()).value).toMatchObject({ type: 'save', save });
    expect(finished).toBe(false);
    expect(authorization).toBe('Bearer private-token');
    release();
    const remaining = await collect(events);
    expect(remaining.at(-1)).toMatchObject({
      type: 'complete',
      data: {
        currentSessionIndex: 0,
        sessions: [{ saveHeaders: Array.from({ length: 6 }, () => save), sessionName: 'Factory' }],
      },
    });
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

it('uses pinned anonymous bootstrap and treats rejected game tokens independently of panel login', async () => {
  const authorizations: (string | undefined)[] = [];
  let status = 200;
  const server = createServer(
    { key: identity.privateKeyPem, cert: identity.certificatePem },
    (req, res) => {
      authorizations.push(req.headers.authorization);
      req.resume();
      req.on('end', () => {
        res.writeHead(status);
        res.end('{"data":{"authenticationToken":"native.token"}}');
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  try {
    const endpoint = { address: '127.0.0.1', port: address.port };
    expect(
      await satisfactoryPinnedTransport(endpoint, identity.certificatePem).request({
        function: 'PasswordlessLogin',
      }),
    ).toEqual({ data: { authenticationToken: 'native.token' } });
    status = 401;
    await expect(
      satisfactoryPinnedTransport(endpoint, identity.certificatePem, 'revoked').request({
        function: 'QueryServerState',
      }),
    ).rejects.toMatchObject({ code: 'game_authentication_failed', status: 409 });
    status = 503;
    await expect(
      satisfactoryPinnedTransport(endpoint, identity.certificatePem, 'token').request({
        function: 'QueryServerState',
      }),
    ).rejects.toMatchObject({ code: 'game_not_ready' });
    expect(authorizations).toEqual([undefined, 'Bearer revoked', 'Bearer token']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
