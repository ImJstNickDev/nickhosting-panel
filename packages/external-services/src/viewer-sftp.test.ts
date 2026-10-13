import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, type Connection, Server, utils } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ViewerSftpConnection, ViewerSftpPool, viewerSftpPath } from './viewer-sftp.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
const parsedKey = utils.parseKey(privateKey);
if (parsedKey instanceof Error || Array.isArray(parsedKey)) throw new Error('Fixture host key');
const fingerprint = `SHA256:${createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
const status = utils.sftp.STATUS_CODE;
const pools: ViewerSftpPool[] = [];
const clients = new Set<Connection>();
const content = Buffer.alloc(4 * 1024 * 1024);
for (let index = 0; index < content.length; index++) content[index] = index % 251;
let connections = 0;
let subsystems = 0;
let reads = 0;
let opens = 0;
let closes = 0;
let activeReads = 0;
let peakReads = 0;
let port = 0;

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  clients.add(client);
  connections++;
  client.on('error', () => {});
  client.on('close', () => clients.delete(client));
  client.on('authentication', (context) => {
    if (context.method === 'password' && context.password === 'a'.repeat(43)) context.accept();
    else context.reject();
  });
  client.on('ready', () =>
    client.on('session', (accept) => {
      const session = accept();
      session.on('sftp', (accept) => {
        const channel = accept();
        let closed = false;
        channel.once('close', () => {
          closed = true;
        });
        subsystems++;
        let sequence = 0;
        const handles = new Map<string, string>();
        channel.on('OPEN', (id, path, flags) => {
          expect(flags).toBe(utils.sftp.OPEN_MODE.READ);
          if (
            !['/fixture.bin', '/delayed', '/stalled', '/directory', '/truncated'].includes(path)
          ) {
            channel.status(id, status.NO_SUCH_FILE);
            return;
          }
          const handle = Buffer.from(String(++sequence));
          handles.set(handle.toString(), path);
          opens++;
          channel.handle(id, handle);
        });
        channel.on('FSTAT', (id, handle) =>
          channel.attrs(id, {
            size: content.length,
            uid: 1000,
            gid: 1000,
            mode: handles.get(handle.toString()) === '/directory' ? 0o040755 : 0o100644,
            atime: 1_900_000_000,
            mtime: 1_900_000_001,
          }),
        );
        channel.on('READ', (id, handle, offset, length) => {
          reads++;
          const path = handles.get(handle.toString());
          if (!path) {
            channel.status(id, status.FAILURE);
            return;
          }
          if (path === '/stalled') return;
          if (path === '/truncated' || offset >= content.length) {
            channel.status(id, status.EOF);
            return;
          }
          activeReads++;
          peakReads = Math.max(peakReads, activeReads);
          const respond = () => {
            activeReads--;
            if (!closed)
              channel.data(id, content.subarray(offset, Math.min(offset + length, content.length)));
          };
          if (path === '/delayed') setTimeout(respond, 40);
          else respond();
        });
        channel.on('CLOSE', (id, handle) => {
          closes++;
          handles.delete(handle.toString());
          channel.status(id, status.OK);
        });
      });
    }),
  );
});

function connection(overrides: Partial<ViewerSftpConnection> = {}): ViewerSftpConnection {
  const credentialId = overrides.credentialId ?? randomUUID();
  return {
    serverId: randomUUID(),
    externalServerUuid: randomUUID(),
    host: '127.0.0.1',
    port,
    password: 'a'.repeat(43),
    hostFingerprint: fingerprint,
    expiresAt: Date.now() + 60_000,
    ...overrides,
    credentialId,
    username: `nhv_${credentialId.replaceAll('-', '')}`,
  };
}

function pool(options: ConstructorParameters<typeof ViewerSftpPool>[0] = {}): ViewerSftpPool {
  const result = new ViewerSftpPool(options);
  pools.push(result);
  return result;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port');
  port = address.port;
});
afterEach(async () => {
  for (const pool of pools.splice(0)) pool.dispose();
  await delay(5);
});
afterAll(async () => {
  for (const client of clients) client.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('private viewer SFTP transport with real SSH protocol fixtures', () => {
  it('disables Nagle once on the shared SSH socket before file operations', async () => {
    const noDelay = vi.spyOn(Client.prototype, 'setNoDelay');
    try {
      const transport = pool();
      const options = connection();
      const files = await Promise.all([
        transport.openFile(options, 'fixture.bin'),
        transport.openFile(options, 'fixture.bin'),
      ]);
      expect(noDelay).toHaveBeenCalledExactlyOnceWith(true);
      expect(await files[0]?.read(0, 64)).toEqual(content.subarray(0, 64));
      await Promise.all(files.map((file) => file.close()));
    } finally {
      noDelay.mockRestore();
    }
  });

  it('shares the handshake/channel across concurrent opens and reads exact offset ranges', async () => {
    const before = { connections, subsystems, opens, closes };
    const transport = pool();
    const options = connection();
    const files = await Promise.all(
      [1, 2, 3].map(() => transport.openFile(options, 'fixture.bin')),
    );
    expect(connections - before.connections).toBe(1);
    expect(subsystems - before.subsystems).toBe(1);
    expect(opens - before.opens).toBe(3);
    expect(files[0]?.stat).toEqual({
      size: content.length,
      mtimeMs: 1_900_000_001_000,
      mode: 0o100644,
    });
    expect(await files[0]?.read(1_000_001, 400_000)).toEqual(
      content.subarray(1_000_001, 1_400_001),
    );
    expect(await files[1]?.read(7, 19)).toEqual(content.subarray(7, 26));
    await Promise.all(files.map((file) => file.close()));
    expect(closes - before.closes).toBe(3);
  });

  it('requires a pinned host key and never exposes provider/network credential errors', async () => {
    const options = connection({
      hostFingerprint: `SHA256:${Buffer.alloc(32).toString('base64').replace(/=+$/, '')}`,
    });
    await expect(pool().openFile(options, '/fixture.bin')).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    await expect(
      pool().openFile(connection({ password: 'wrong-secret'.repeat(4) }), '/fixture.bin'),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
  });

  it('rejects traversal and untrusted connection shape before opening a network connection', async () => {
    const before = connections;
    for (const path of [
      '',
      '../other',
      '/a/../other',
      '/a/./b',
      '/a\\b',
      '/a\0b',
      '/a\nb',
      '//host/file',
    ]) {
      await expect(pool().openFile(connection(), path)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    }
    expect(viewerSftpPath('/name with spaces.json')).toBe('/name with spaces.json');
    await expect(
      pool().openFile(connection({ hostFingerprint: '' }), '/fixture.bin'),
    ).rejects.toMatchObject({ code: 'configuration_invalid' });
    await expect(
      pool().openFile(connection({ expiresAt: Date.now() - 1 }), '/fixture.bin'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(connections).toBe(before);
  });

  it('streams with backpressure and closes the handle after normal completion', async () => {
    const file = await pool().openFile(connection(), '/fixture.bin');
    const beforeReads = reads;
    const beforeClose = closes;
    const stream = file.stream({ start: 123, endExclusive: 786_555 });
    await delay(30);
    expect(reads - beforeReads).toBe(0); // Not flowing: no speculative remote reads.
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(content.subarray(123, 786_555));
    expect(closes - beforeClose).toBe(1);
    await expect(file.read(0, 1)).rejects.toThrow();
  });

  it('aborts an active stream and a stalled request when its credential is revoked', async () => {
    const transport = pool();
    const options = connection();
    const file = await transport.openFile(options, '/stalled');
    const result = file.read(0, 10);
    const rejection = expect(result).rejects.toMatchObject({ code: 'forbidden' });
    transport.revokeCredential(options.credentialId);
    await rejection;
    await expect(file.read(0, 10)).rejects.toThrow();

    const secondOptions = connection();
    const second = await transport.openFile(secondOptions, '/delayed');
    const stream = second.stream();
    const outcome = (async () => {
      for await (const _ of stream) {
        /* consume */
      }
    })();
    const streamRejection = expect(outcome).rejects.toThrow();
    transport.revokeServer(secondOptions.serverId);
    await streamRejection;
  });

  it('cancels one open handle without closing the other request sharing its SSH session', async () => {
    const transport = pool();
    const options = connection();
    const controller = new AbortController();
    const [first, second] = await Promise.all([
      transport.openFile(options, '/delayed', { signal: controller.signal }),
      transport.openFile(options, '/fixture.bin'),
    ]);
    const read = first.read(0, 32);
    const rejection = expect(read).rejects.toThrow();
    controller.abort();
    await rejection;
    expect(await second.read(0, 32)).toEqual(content.subarray(0, 32));
    await second.close();
  });

  it('closes a stalled stream promptly when its HTTP consumer cancels, without waiting for provider timeout', async () => {
    const file = await pool().openFile(connection(), '/stalled');
    const stream = file.stream();
    stream.resume();
    await delay(10);
    const started = Date.now();
    const closed = new Promise<void>((resolve) => stream.once('close', resolve));
    stream.destroy();
    await closed;
    expect(Date.now() - started).toBeLessThan(500);
    await expect(file.read(0, 1)).rejects.toThrow();
  });

  it('bounds concurrent reads, pending requests, handles and pool size', async () => {
    const transport = pool({
      maxConcurrentPerConnection: 1,
      maxPendingPerConnection: 1,
      maxOpenFilesPerConnection: 1,
      maxConnections: 1,
    });
    const options = connection();
    const file = await transport.openFile(options, '/delayed');
    await expect(transport.openFile(options, '/fixture.bin')).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(transport.openFile(connection(), '/fixture.bin')).rejects.toMatchObject({
      code: 'conflict',
    });
    peakReads = 0;
    const first = file.read(0, 10);
    const second = file.read(10, 10);
    await expect(file.read(20, 10)).rejects.toMatchObject({ code: 'conflict' });
    await Promise.all([first, second]);
    expect(peakReads).toBe(1);
    await file.close();
    const next = await transport.openFile(connection(), '/fixture.bin'); // Evicts the idle connection.
    await next.close();
  });

  it('refuses directories, overlarge reads and source truncation instead of returning incomplete bytes', async () => {
    const transport = pool();
    const options = connection();
    await expect(transport.openFile(options, '/directory')).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(transport.openFile(options, '/missing')).rejects.toMatchObject({
      code: 'not_found',
    });
    const file = await transport.openFile(options, '/fixture.bin');
    await expect(file.read(-1, 4)).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(file.read(0, 4 * 1024 * 1024 + 1)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(await file.read(content.length - 2, 4)).toEqual(content.subarray(-2));
    await file.close();
    const truncated = await transport.openFile(options, '/truncated');
    await expect(truncated.read(0, 10)).rejects.toMatchObject({ code: 'conflict' });
    await truncated.close();
  });

  it('times out stalled operations and reconnects after an idle connection is reaped', async () => {
    const transport = pool({ operationTimeoutMs: 1000, idleTimeoutMs: 30 });
    const options = connection();
    const file = await transport.openFile(options, '/stalled');
    await expect(file.read(0, 1)).rejects.toMatchObject({ code: 'integration_unavailable' });
    const normal = await transport.openFile(options, '/fixture.bin');
    await normal.close();
    const before = connections;
    await delay(100);
    const afterIdle = await transport.openFile(options, '/fixture.bin');
    expect(connections - before).toBe(1);
    await afterIdle.close();
  });
});
