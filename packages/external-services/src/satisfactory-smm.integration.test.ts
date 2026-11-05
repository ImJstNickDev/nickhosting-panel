import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storagePath } from '../../../deploy/storage-root.mjs';
import { generateSftpPassword, type SftpCredentialRef, SftpGoAdapter } from './sftpgo.js';

/** Opt-in upstream interoperability evidence. Only the isolated test-env SFTPGo
 * is accepted; no real game installation or provider account is involved. */
describe.skipIf(!process.env.NH_TEST_FICSIT_PATH || !process.env.NH_TEST_SFTPGO_URL)(
  'upstream SMM filesystem engine against isolated SFTPGo',
  () => {
    let adapter: SftpGoAdapter;
    let credential: SftpCredentialRef | undefined;
    let game: string | undefined;
    let state: string | undefined;
    let remote: string;
    const serverId = randomUUID();
    const password = generateSftpPassword();
    const required = (name: string) => {
      const value = process.env[name];
      if (!value) throw new Error(`Missing isolated test setting: ${name}`);
      return value;
    };
    beforeAll(async () => {
      const root = await realpath(required('NH_TEST_SFTPGO_LOCAL_DATA_ROOT'));
      if (
        root !== (await realpath(storagePath('m2-tests/sftpgo/data'))) ||
        required('NH_TEST_SFTPGO_DATA_ROOT') !== '/srv/sftpgo/data'
      )
        throw new Error('Not an isolated SFTPGo root');
      const binary = await readFile(required('NH_TEST_FICSIT_PATH'));
      expect(createHash('sha256').update(binary).digest('hex')).toBe(
        process.arch === 'arm64'
          ? 'a591eb87be517d9d03798184c210d7166141be19e37b9d4e5fe68c84f264c6bf'
          : '2af0f8815af93b097c7a97968569575b21cf451b7c345fbb62fae29096ee4a31',
      );
      const url = new URL(required('NH_TEST_SFTPGO_URL'));
      if (url.hostname !== required('NH_TEST_SFTPGO_HOST'))
        throw new Error('Mismatched isolated endpoints');
      const tokenResponse = await fetch(new URL('/api/v2/token', url), {
        headers: {
          Authorization: `Basic ${Buffer.from(`${required('NH_TEST_SFTPGO_ADMIN_USERNAME')}:${required('NH_TEST_SFTPGO_ADMIN_PASSWORD')}`).toString('base64')}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!tokenResponse.ok) throw new Error('Isolated SFTPGo authentication failed');
      const token = (await tokenResponse.json()) as { access_token: string };
      adapter = new SftpGoAdapter({
        baseURL: url.toString(),
        instanceId: randomUUID(),
        dataRoot: '/srv/sftpgo/data',
        auth: { accessToken: token.access_token },
      });
      game = join(root, serverId);
      await mkdir(join(game, 'Engine/Binaries/Linux'), { recursive: true, mode: 0o755 });
      await writeFile(join(game, 'FactoryServer.sh'), '#!/bin/sh\n', { mode: 0o644 });
      await writeFile(
        join(game, 'Engine/Binaries/Linux/FactoryServer-Linux-Shipping.version'),
        JSON.stringify({ Changelist: 513885 }),
        { mode: 0o644 },
      );
      credential = await adapter.ensureCredential({
        serverId,
        externalServerUuid: serverId,
        credentialId: randomUUID(),
        password,
        expiresAt: 0,
        quotaBytes: 0,
      });
      remote = `sftp://${encodeURIComponent(credential.username)}:${encodeURIComponent(password)}@${required('NH_TEST_SFTPGO_HOST')}:${required('NH_TEST_SFTPGO_PORT')}/`;
      state = await mkdtemp(join(tmpdir(), 'nh-smm-interop-'));
      await writeFile(
        join(state, 'profiles.json'),
        JSON.stringify({
          version: 0,
          selected_profile: 'Interop',
          profiles: { Interop: { name: 'Interop', mods: {}, required_targets: ['LinuxServer'] } },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        join(state, 'installations.json'),
        JSON.stringify({
          version: 0,
          selected_installation: remote,
          installations: [{ path: remote, profile: 'Interop', vanilla: false }],
        }),
        { mode: 0o600 },
      );
    });
    afterAll(async () => {
      if (credential) await adapter.revokeCredential(credential);
      if (game) await rm(game, { recursive: true, force: true });
      if (state) await rm(state, { recursive: true, force: true });
    });
    async function apply() {
      // Credentials stay in the private installations file, never argv/output.
      try {
        await promisify(execFile)(
          required('NH_TEST_FICSIT_PATH'),
          [
            '--local-dir',
            state!,
            '--cache-dir',
            join(state!, 'cache'),
            '--pretty=false',
            '--quiet',
            'apply',
          ],
          { timeout: 60000, maxBuffer: 1048576 },
        );
      } catch {
        throw new Error('Upstream ficsit remote apply failed (provider output suppressed)');
      }
    }
    it('discovers the Linux server and writes its native profile lock over SFTP', async () => {
      await apply();
      const lock = JSON.parse(
        await readFile(join(game!, 'FactoryGame/Mods/interop-lock.json'), 'utf8'),
      );
      expect(lock).toMatchObject({ version: 1 });
      expect(Object.keys(lock.mods ?? {})).toEqual([]);
    }, 65000);
    it('removes managed normal and GameFeature mods while preserving unmanaged files', async () => {
      for (const directory of ['Example', 'GameFeatures/FeatureExample', 'Manual']) {
        await mkdir(join(game!, 'FactoryGame/Mods', directory), { recursive: true, mode: 0o777 });
        await writeFile(join(game!, 'FactoryGame/Mods', directory, 'content.txt'), 'fixture', {
          mode: 0o666,
        });
        if (directory !== 'Manual')
          await writeFile(join(game!, 'FactoryGame/Mods', directory, '.smm'), '', { mode: 0o666 });
      }
      await apply();
      for (const directory of ['Example', 'GameFeatures/FeatureExample'])
        await expect(
          readFile(join(game!, 'FactoryGame/Mods', directory, 'content.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(game!, 'FactoryGame/Mods/Manual/content.txt'), 'utf8')).toBe(
        'fixture',
      );
    }, 65000);
  },
);
