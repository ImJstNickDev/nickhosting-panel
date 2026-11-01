import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const fixtures: string[] = [];
afterEach(async () => {
  for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nh-storage-prep-'));
  fixtures.push(root);
  const bin = join(root, 'bin');
  const storage = join(root, 'storage');
  const capture = join(root, 'docker-calls.jsonl');
  await mkdir(bin);
  await mkdir(storage);
  const mock = join(root, 'docker.mjs');
  await writeFile(
    mock,
    `
    import { appendFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync(process.env.NH_TEST_DOCKER_CAPTURE, JSON.stringify(args) + '\\n');
    process.exit(args[0] === 'container' && args[1] === 'inspect' ? 1 : 0);
  `,
  );
  await writeFile(
    join(bin, 'docker'),
    '#!/bin/sh\nexec "$NH_TEST_NODE" "$NH_TEST_DOCKER_MOCK" "$@"\n',
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    NH_MOUNTDATA_ROOT: storage,
    NH_TEST_NODE: process.execPath,
    NH_TEST_DOCKER_MOCK: mock,
    NH_TEST_DOCKER_CAPTURE: capture,
  };
  return { root, storage, capture, env };
}

it.each(['viewer', 'sftp-users'])(
  'prepares only fresh %s state in the configured root',
  async (kind) => {
    const { storage, capture, env } = await fixture();
    await mkdir(join(storage, 'dev'));
    const script = resolve(`deploy/prepare-${kind}-state.sh`);
    const args = [
      script,
      '--owner-approved',
      String(process.getuid?.()),
      String(process.getgid?.()),
    ];
    execFileSync('bash', args, { env, stdio: 'pipe' });
    const state = join(storage, 'dev', kind === 'viewer' ? 'sftpgo-viewer' : 'sftpgo-users');
    expect((await lstat(state)).mode & 0o777).toBe(0o700);
    const calls = (await readFile(capture, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    const run = calls.find((call) => call[0] === 'run');
    expect(run?.find((arg) => arg.startsWith('type=bind,'))).toContain(`src=${state},`);
    expect(run).not.toContain('--volume');
    await writeFile(join(state, 'keep'), 'unchanged');
    const before = await readFile(capture, 'utf8');
    const retry = spawnSync('bash', args, { env, encoding: 'utf8' });
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain('already exists');
    expect(await readFile(capture, 'utf8')).toBe(before);
    expect(await readFile(join(state, 'keep'), 'utf8')).toBe('unchanged');
  },
);

it('refuses a missing custom root before invoking a preparation helper', async () => {
  const { root, capture, env } = await fixture();
  const result = spawnSync(
    'bash',
    [resolve('scripts/prepare-m2-test-directories.sh'), '--owner-approved'],
    {
      env: { ...env, NH_MOUNTDATA_ROOT: join(root, 'missing-disk') },
      encoding: 'utf8',
    },
  );
  expect(result.status).not.toBe(0);
  await expect(lstat(capture)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(join(root, 'missing-disk'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([false, true])(
  'creates fresh test directories without changing existing state (M1=%s)',
  async (m1) => {
    const { storage, capture, env } = await fixture();
    const scope = m1 ? 'm1-tests' : 'm2-tests';
    const script = resolve('scripts/prepare-m2-test-directories.sh');
    execFileSync('bash', [script, '--owner-approved', ...(m1 ? ['--m1'] : [])], {
      env,
      stdio: 'pipe',
    });
    const run = JSON.parse((await readFile(capture, 'utf8')).trim()) as string[];
    expect(run.find((arg) => arg.startsWith('type=bind,'))).toBe(
      `type=bind,src=${storage},dst=/storage`,
    );
    const program = run[run.indexOf('-c') + 1];
    if (!program) throw new Error('Missing test preparation program');
    // Execute the same bounded directory program locally against an isolated fixture;
    // no Docker container or live directory is created by this test.
    const uid = String(process.getuid?.());
    const gid = String(process.getgid?.());
    const execute = () =>
      execFileSync('/bin/sh', ['-eu', '-c', program, 'prepare-tests', uid, gid, scope, storage], {
        stdio: 'pipe',
      });
    execute();
    expect((await lstat(join(storage, scope, 'postgres'))).mode & 0o777).toBe(0o711);
    const existing = join(storage, scope, 'redis');
    await chmod(existing, 0o750);
    await writeFile(join(existing, 'keep'), 'existing-state');
    execute();
    expect((await lstat(existing)).mode & 0o777).toBe(0o750);
    expect(await readFile(join(existing, 'keep'), 'utf8')).toBe('existing-state');
    expect(await readdir(join(storage, scope))).toEqual(
      expect.arrayContaining(['postgres', 'redis']),
    );
    if (!m1) {
      const target = join(storage, scope, 'sftpgo', 'data');
      await rm(target, { recursive: true });
      await symlink(existing, target);
      expect(execute).toThrow();
      expect(await readFile(join(existing, 'keep'), 'utf8')).toBe('existing-state');
    }
  },
);
