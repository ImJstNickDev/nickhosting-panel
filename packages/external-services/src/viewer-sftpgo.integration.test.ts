import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client, type SFTPWrapper } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSftpPassword } from './sftpgo.js';
import { type ViewerSftpConnection, ViewerSftpPool } from './viewer-sftp.js';
import { SftpGoViewerAdapter, type ViewerSftpCredentialRef } from './viewer-sftpgo.js';

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing isolated test setting: ${key}`);
  return value;
};

describe.skipIf(!process.env.NH_TEST_SFTPGO_URL)(
  'viewer transport against isolated SFTPGo 2.7.6',
  () => {
    const externalUuid = randomUUID();
    const otherUuid = randomUUID();
    const missingUuid = randomUUID();
    const credentialId = randomUUID();
    const serverId = randomUUID();
    const password = generateSftpPassword();
    const directories: string[] = [];
    const refs: ViewerSftpCredentialRef[] = [];
    const pool = new ViewerSftpPool();
    let root: string;
    let adapter: SftpGoViewerAdapter;
    let connection: ViewerSftpConnection;
    const clients: Client[] = [];

    async function rawConnection(options: ViewerSftpConnection): Promise<SFTPWrapper> {
      const client = new Client();
      clients.push(client);
      return new Promise((resolvePromise, reject) => {
        client.on('error', reject);
        client.once('ready', () =>
          client.sftp((error, channel) => (error ? reject(error) : resolvePromise(channel))),
        );
        client.connect({
          host: options.host,
          port: options.port,
          username: options.username,
          password: options.password,
          readyTimeout: 5000,
          hostVerifier: (key: Buffer) =>
            `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` ===
            options.hostFingerprint,
        });
      });
    }

    beforeAll(async () => {
      root = await realpath(required('NH_TEST_SFTPGO_LOCAL_DATA_ROOT'));
      if (
        root !== resolve('mountdata/m2-tests/sftpgo/data') ||
        required('NH_TEST_SFTPGO_DATA_ROOT') !== '/srv/sftpgo/data'
      )
        throw new Error('Not the approved isolated SFTPGo fixture root');
      const publicKey = await readFile(
        resolve('mountdata/m2-tests/sftpgo/state/id_ed25519.pub'),
        'utf8',
      );
      const rawKey = publicKey.trim().split(/\s+/)[1];
      if (!rawKey) throw new Error('Missing isolated host public key');
      const hostFingerprint = `SHA256:${createHash('sha256').update(Buffer.from(rawKey, 'base64')).digest('base64').replace(/=+$/, '')}`;
      const tokenResponse = await fetch(new URL('/api/v2/token', required('NH_TEST_SFTPGO_URL')), {
        headers: {
          Authorization: `Basic ${Buffer.from(`${required('NH_TEST_SFTPGO_ADMIN_USERNAME')}:${required('NH_TEST_SFTPGO_ADMIN_PASSWORD')}`).toString('base64')}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!tokenResponse.ok) throw new Error('Isolated SFTPGo login failed');
      const token = (await tokenResponse.json()) as { access_token: string };
      adapter = new SftpGoViewerAdapter({
        baseURL: required('NH_TEST_SFTPGO_URL'),
        auth: { accessToken: token.access_token },
        instanceId: randomUUID(),
        dataRoot: '/srv/sftpgo/data',
      });
      for (const id of [externalUuid, otherUuid]) {
        const directory = join(root, id);
        await mkdir(directory, { mode: 0o750 });
        directories.push(directory);
      }
      await writeFile(join(root, externalUuid, 'data.bin'), Buffer.from('0123456789abcdef'));
      await writeFile(join(root, otherUuid, 'other-private.txt'), 'another server');
      await symlink(
        `/srv/sftpgo/data/${otherUuid}/other-private.txt`,
        join(root, externalUuid, 'escape-link'),
      );
      const before = await stat(join(root, externalUuid));
      const ref = await adapter.ensureCredential({
        serverId,
        externalServerUuid: externalUuid,
        credentialId,
        password,
        expiresAt: Date.now() + 600_000,
      });
      refs.push(ref);
      expect(await stat(join(root, externalUuid))).toMatchObject({
        uid: before.uid,
        gid: before.gid,
        mode: before.mode,
      });
      connection = {
        serverId,
        externalServerUuid: externalUuid,
        credentialId,
        host: required('NH_TEST_SFTPGO_HOST'),
        port: Number(required('NH_TEST_SFTPGO_PORT')),
        username: ref.username,
        password,
        expiresAt: ref.expiresAt,
        hostFingerprint,
      };
    });

    afterAll(async () => {
      pool.dispose();
      for (const client of clients) client.destroy();
      for (const ref of refs) await adapter?.revokeCredential(ref);
      for (const directory of directories) await rm(directory, { recursive: true });
    });

    it('reads exact ranges and preserves filesystem ownership/permissions', async () => {
      const before = await stat(join(root, externalUuid));
      const file = await pool.openFile(connection, '/data.bin');
      expect((await file.read(4, 5)).toString()).toBe('45678');
      const chunks: Buffer[] = [];
      for await (const chunk of file.stream({ start: 9, endExclusive: 16 })) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('9abcdef');
      expect(await stat(join(root, externalUuid))).toMatchObject({
        uid: before.uid,
        gid: before.gid,
        mode: before.mode,
      });
    });

    it('denies writing, deleting, cross-server paths and pre-existing symlink escapes', async () => {
      for (const path of [
        '/other-private.txt',
        '/escape-link',
        `/srv/sftpgo/data/${otherUuid}/other-private.txt`,
        `../${otherUuid}/other-private.txt`,
      ])
        await expect(pool.openFile(connection, path)).rejects.toThrow();
      const channel = await rawConnection(connection);
      await expect(
        new Promise<void>((resolvePromise, reject) =>
          channel.writeFile('/data.bin', 'modified', (error) =>
            error ? reject(error) : resolvePromise(),
          ),
        ),
      ).rejects.toThrow();
      await expect(
        new Promise<void>((resolvePromise, reject) =>
          channel.unlink('/data.bin', (error) => (error ? reject(error) : resolvePromise())),
        ),
      ).rejects.toThrow();
      expect((await readFile(join(root, externalUuid, 'data.bin'))).toString()).toBe(
        '0123456789abcdef',
      );
      expect((await readFile(join(root, otherUuid, 'other-private.txt'))).toString()).toBe(
        'another server',
      );
      channel.end();
    });

    it('does not create a missing server home on account creation or first login', async () => {
      const missingCredential = randomUUID();
      const ref = await adapter.ensureCredential({
        serverId: randomUUID(),
        externalServerUuid: missingUuid,
        credentialId: missingCredential,
        password,
        expiresAt: Date.now() + 600_000,
      });
      refs.push(ref);
      const options = {
        ...connection,
        serverId: ref.serverId,
        externalServerUuid: missingUuid,
        credentialId: missingCredential,
        username: ref.username,
        expiresAt: ref.expiresAt,
      };
      await expect(pool.openFile(options, '/missing.bin')).rejects.toThrow();
      await expect(stat(join(root, missingUuid))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('closes a retained application transport during local credential invalidation', async () => {
      const file = await pool.openFile(connection, '/data.bin');
      pool.revokeCredential(connection.credentialId);
      await expect(file.read(0, 1)).rejects.toThrow();
      // This proves the application's own transport closure, not an upstream #18 fix.
    });
  },
);
