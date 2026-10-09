import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client, type SFTPWrapper } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSftpPassword, type SftpCredentialRef, SftpGoAdapter } from './index.js';

const enabled = Boolean(process.env.NH_TEST_SFTPGO_URL);
describe.skipIf(!enabled)('isolated SFTPGo real filesystem and protocol', () => {
  let adapter: SftpGoAdapter;
  let localRoot: string;
  let adminToken: string;
  const refs: SftpCredentialRef[] = [];
  const directories: string[] = [];
  const connections: Client[] = [];
  const instanceId = randomUUID();
  const serverA = randomUUID();
  const serverB = randomUUID();
  const passwordA = generateSftpPassword();
  const passwordB = generateSftpPassword();
  let refA: SftpCredentialRef;
  let refB: SftpCredentialRef;

  function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing isolated SFTPGo test variable: ${name}`);
    return value;
  }
  async function connect(
    ref: SftpCredentialRef,
    password: string,
  ): Promise<{ client: Client; sftp: SFTPWrapper }> {
    const client = new Client();
    connections.push(client);
    return new Promise((resolvePromise, reject) => {
      client.on('error', reject);
      client.once('ready', () =>
        client.sftp((error, sftp) => (error ? reject(error) : resolvePromise({ client, sftp }))),
      );
      client.connect({
        host: required('NH_TEST_SFTPGO_HOST'),
        port: Number(required('NH_TEST_SFTPGO_PORT')),
        username: ref.username,
        password,
        readyTimeout: 5000,
      });
    });
  }
  function read(sftp: SFTPWrapper, path: string): Promise<string> {
    return new Promise((resolvePromise, reject) =>
      sftp.readFile(path, (error, data) =>
        error ? reject(error) : resolvePromise(data.toString('utf8')),
      ),
    );
  }
  function write(sftp: SFTPWrapper, path: string, data: string): Promise<void> {
    return new Promise((resolvePromise, reject) =>
      sftp.writeFile(path, data, (error) => (error ? reject(error) : resolvePromise())),
    );
  }
  function closed(client: SFTPWrapper): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Credential mutation did not close the active session')),
        5000,
      );
      client.once('close', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }

  beforeAll(async () => {
    // This guard prevents accidental real Wings roots even when test variables are misconfigured.
    localRoot = await realpath(required('NH_TEST_SFTPGO_LOCAL_DATA_ROOT'));
    const isolatedRoot = resolve(process.cwd(), 'mountdata/m2-tests/sftpgo/data');
    if (localRoot !== isolatedRoot || required('NH_TEST_SFTPGO_DATA_ROOT') !== '/srv/sftpgo/data')
      throw new Error('SFTPGo test root is not the approved isolated directory');
    const url = new URL(required('NH_TEST_SFTPGO_URL'));
    if (url.hostname !== required('NH_TEST_SFTPGO_HOST'))
      throw new Error('SFTPGo test endpoints differ');
    const tokenResponse = await fetch(new URL('/api/v2/token', url), {
      headers: {
        Authorization: `Basic ${Buffer.from(`${required('NH_TEST_SFTPGO_ADMIN_USERNAME')}:${required('NH_TEST_SFTPGO_ADMIN_PASSWORD')}`).toString('base64')}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!tokenResponse.ok) throw new Error('Isolated SFTPGo admin authentication failed');
    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!token.access_token) throw new Error('Missing isolated access token');
    adminToken = token.access_token;
    const version = await fetch(new URL('/api/v2/version', url), {
      headers: { Authorization: `Bearer ${token.access_token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    expect(version.ok).toBe(true);
    expect(await version.json()).toMatchObject({ version: '2.7.6' });
    adapter = new SftpGoAdapter({
      baseURL: url.toString(),
      instanceId,
      dataRoot: required('NH_TEST_SFTPGO_DATA_ROOT'),
      auth: { accessToken: token.access_token },
    });
    for (const id of [serverA, serverB]) {
      const directory = join(localRoot, id);
      await mkdir(directory);
      directories.push(directory);
    }
    await writeFile(join(localRoot, serverA, 'owned.txt'), 'server A fixture');
    await writeFile(join(localRoot, serverB, 'private.txt'), 'server B fixture');
    // The link exists outside SFTPGo, as files created by a game could. Reading must still be confined.
    await symlink(
      join('/srv/sftpgo/data', serverB, 'private.txt'),
      join(localRoot, serverA, 'escape-link'),
    );
    refA = await adapter.ensureCredential({
      serverId: serverA,
      externalServerUuid: serverA,
      credentialId: randomUUID(),
      password: passwordA,
      expiresAt: Date.now() + 600_000,
      quotaBytes: 1_048_576,
    });
    refs.push(refA);
    refB = await adapter.ensureCredential({
      serverId: serverB,
      externalServerUuid: serverB,
      credentialId: randomUUID(),
      password: passwordB,
      expiresAt: Date.now() + 600_000,
      quotaBytes: 1_048_576,
    });
    refs.push(refB);
  });

  afterAll(async () => {
    for (const client of connections) client.end();
    for (const ref of refs) await adapter.revokeCredential(ref);
    for (const directory of directories) await rm(directory, { recursive: true });
  });

  it('reads/writes only the selected server, denying traversal and pre-existing symlink escapes', async () => {
    const a = await connect(refA, passwordA);
    const b = await connect(refB, passwordB);
    expect(await read(a.sftp, '/owned.txt')).toBe('server A fixture');
    expect(await read(b.sftp, '/private.txt')).toBe('server B fixture');
    await write(a.sftp, '/new.txt', 'new A data');
    expect(await readFile(join(localRoot, serverA, 'new.txt'), 'utf8')).toBe('new A data');
    for (const path of [
      '/private.txt',
      `../${serverB}/private.txt`,
      `/srv/sftpgo/data/${serverB}/private.txt`,
      `/..\\${serverB}\\private.txt`,
      '/escape-link',
    ]) {
      await expect(read(a.sftp, path)).rejects.toThrow();
    }
    await expect(
      new Promise<void>((resolvePromise, reject) =>
        a.sftp.symlink(`../${serverB}/private.txt`, '/new-link', (error) =>
          error ? reject(error) : resolvePromise(),
        ),
      ),
    ).rejects.toThrow();
    expect(await readFile(join(localRoot, serverB, 'private.txt'), 'utf8')).toBe(
      'server B fixture',
    );
    a.client.end();
    b.client.end();
  });

  it('closes an authenticated SSH transport through the explicit connection deletion API', async () => {
    const current = await connect(refA, passwordA);
    try {
      const base = required('NH_TEST_SFTPGO_URL');
      const headers = { Authorization: `Bearer ${adminToken}` };
      const account = await fetch(new URL(`/api/v2/users/${refA.username}`, base), {
        headers,
        redirect: 'error',
      });
      expect(account.ok).toBe(true);
      expect(((await account.json()) as { id: number }).id).toBe(refA.externalUserId);
      const response = await fetch(new URL('/api/v2/connections', base), {
        headers,
        redirect: 'error',
      });
      expect(response.ok).toBe(true);
      const owned = (
        (await response.json()) as { username: string; connection_id: string }[]
      ).filter((entry) => entry.username === refA.username);
      expect(owned.length).toBeGreaterThan(0);
      const disconnected = closed(current.sftp);
      for (const connection of owned) {
        const deleted = await fetch(
          new URL(`/api/v2/connections/${encodeURIComponent(connection.connection_id)}`, base),
          { method: 'DELETE', headers, redirect: 'error' },
        );
        expect(deleted.ok).toBe(true);
      }
      await disconnected;
      const reopened = await new Promise<SFTPWrapper | null>((resolvePromise) =>
        current.client.sftp((error, channel) => resolvePromise(error ? null : channel)),
      );
      const retainedAccess = reopened
        ? await read(reopened, '/owned.txt').then(
            () => true,
            () => false,
          )
        : false;
      expect(retainedAccess).toBe(false);
    } finally {
      current.client.end();
    }
  });

  it('rotates a password and disconnects existing sessions before accepting the new password', async () => {
    const current = await connect(refA, passwordA);
    const disconnected = closed(current.sftp);
    const nextPassword = generateSftpPassword();
    refA = await adapter.rotateCredential(refA, {
      password: nextPassword,
      expiresAt: Date.now() + 600_000,
    });
    await disconnected;
    const reopened = await new Promise<SFTPWrapper | null>((resolvePromise) =>
      current.client.sftp((error, channel) => resolvePromise(error ? null : channel)),
    );
    const retainedAccess = reopened
      ? await read(reopened, '/owned.txt').then(
          () => true,
          () => false,
        )
      : false;
    await new Promise<void>((resolvePromise) => {
      current.client.once('close', resolvePromise);
      current.client.end();
    });
    expect(
      await connect(refA, passwordA).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const next = await connect(refA, nextPassword);
    expect(await read(next.sftp, '/owned.txt')).toBe('server A fixture');
    next.client.end();
    expect(retainedAccess).toBe(false);
  });

  it('revokes new logins and active SFTP sessions while preserving both directories', async () => {
    const current = await connect(refB, passwordB);
    const disconnected = closed(current.sftp);
    await adapter.revokeCredential(refB);
    await disconnected;
    const reopened = await new Promise<SFTPWrapper | null>((resolvePromise) =>
      current.client.sftp((error, channel) => resolvePromise(error ? null : channel)),
    );
    const retainedAccess = reopened
      ? await read(reopened, '/private.txt').then(
          () => true,
          () => false,
        )
      : false;
    expect(
      await connect(refB, passwordB).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await readFile(join(localRoot, serverB, 'private.txt'), 'utf8')).toBe(
      'server B fixture',
    );
    expect(await readFile(join(localRoot, serverA, 'owned.txt'), 'utf8')).toBe('server A fixture');
    expect(retainedAccess).toBe(false);
  });
});
