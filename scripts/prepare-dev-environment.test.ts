import { execFileSync } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
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
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseDevPreparationArgs,
  prepareDevelopmentEnvironment,
} from './prepare-dev-environment.mjs';

const temporary: string[] = [];
const publicUrl = 'https://development.example.test';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nickhosting-dev-preparation-'));
  temporary.push(root);
  return root;
}

async function files(root: string, relative = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name);
    result.push(entry.isDirectory() ? `${name}/` : name);
    if (entry.isDirectory()) result.push(...(await files(root, name)));
  }
  return result.sort();
}

afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('future development-only preparation', () => {
  it('requires explicit approval and a public origin, with no production or arbitrary root option', () => {
    for (const args of [
      [],
      ['--public-url', publicUrl],
      ['--owner-approved'],
      ['--owner-approved', '--public-url', publicUrl, '--production'],
      ['--owner-approved', '--public-url', publicUrl, '--root', '/elsewhere'],
      ['--owner-approved', '--public-url', publicUrl, '--owner-approved'],
    ])
      expect(() => parseDevPreparationArgs(args)).toThrow();
    expect(parseDevPreparationArgs(['--owner-approved', '--public-url', publicUrl])).toEqual({
      ownerApproved: true,
      publicUrl,
    });
  });

  it('refuses unapproved preparation and invalid URLs before writing anything', async () => {
    const root = await fixture();
    await expect(
      prepareDevelopmentEnvironment({ root, ownerApproved: false, publicUrl }),
    ).rejects.toThrow('--owner-approved');
    for (const invalid of [
      'http://development.example.test',
      'https://development.example.test:8443',
      'https://development.example.test/path',
      'https://development.example.test?key=do-not-print',
      'https://do-not-print@development.example.test',
      'https://development.example.test\n',
    ]) {
      const result = prepareDevelopmentEnvironment({
        root,
        ownerApproved: true,
        publicUrl: invalid,
      });
      await expect(result).rejects.toThrow('exact HTTPS origin');
      await expect(result).rejects.not.toThrow('do-not-print');
    }
    expect(await readdir(root)).toEqual([]);
  });

  it('generates independent secrets, confined directories and a matching trusted mail certificate', async () => {
    const root = await fixture();
    const result = await prepareDevelopmentEnvironment({ root, ownerApproved: true, publicUrl });
    const contents = await readFile(result.envPath, 'utf8');
    const values = Object.fromEntries(
      contents
        .split('\n')
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(values.NH_DEV_ENV_FILE).toBe('.env.dev.local');
    expect(values.NH_DEV_PUBLIC_URL).toBe(publicUrl);
    expect(values.NH_DEV_UID).toBe(String(process.getuid?.()));
    expect(values.NH_DEV_GID).toBe(String(process.getgid?.()));
    const secretFields = [
      'DB_PASSWORD',
      'REDIS_PASSWORD',
      'AUTH_SECRET',
      'SETUP_TOKEN',
      'SANDBOX_TOKEN',
      'MAIL_PASSWORD',
      'MASTER_KEY',
    ];
    const secretValues = secretFields.map((field) => values[`NH_DEV_${field}`] ?? '');
    expect(secretValues.every((value) => value.length >= 32)).toBe(true);
    expect(new Set(secretValues).size).toBe(secretFields.length);
    const masterKey = values.NH_DEV_MASTER_KEY ?? '';
    expect(Buffer.from(masterKey, 'base64')).toHaveLength(32);
    expect(Buffer.from(masterKey, 'base64').toString('base64')).toBe(masterKey);
    expect(Object.keys(values).every((key) => key.startsWith('NH_DEV_'))).toBe(true);

    expect(await files(root)).toEqual(
      [
        '.env.dev.local',
        'mountdata/',
        'mountdata/dev/',
        'mountdata/dev/app/',
        'mountdata/dev/app/content/',
        'mountdata/dev/app/sources/',
        'mountdata/dev/mail-tls/',
        'mountdata/dev/mail-tls/cert.pem',
        'mountdata/dev/mail-tls/key.pem',
        'mountdata/dev/mail-tls/smtp-auth',
        'mountdata/dev/mail/',
        'mountdata/dev/postgres/',
        'mountdata/dev/redis/',
      ].sort(),
    );
    for (const [relative, mode] of [
      ['.env.dev.local', 0o600],
      ['mountdata/dev/mail-tls/key.pem', 0o600],
      ['mountdata/dev/mail-tls/cert.pem', 0o644],
      ['mountdata/dev/mail-tls/smtp-auth', 0o600],
    ] as const) {
      const info = await lstat(join(root, relative));
      expect(info.mode & 0o777).toBe(mode);
      expect(info.uid).toBe(process.getuid?.());
      expect(info.gid).toBe(process.getgid?.());
    }
    expect(await readFile(join(result.devRoot, 'mail-tls/smtp-auth'), 'utf8')).toBe(
      `nickhosting-dev:${values.NH_DEV_MAIL_PASSWORD}\n`,
    );
    const cert = new X509Certificate(await readFile(join(result.devRoot, 'mail-tls/cert.pem')));
    const key = createPrivateKey(await readFile(join(result.devRoot, 'mail-tls/key.pem')));
    expect(cert.subjectAltName).toBe('DNS:mailpit');
    expect(cert.checkHost('mailpit')).toBe('mailpit');
    expect(cert.checkHost('production.example.test')).toBeUndefined();
    expect(cert.checkPrivateKey(key)).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.ca).toBe(true);
    expect(Date.parse(cert.validTo) - Date.now()).toBeGreaterThan(364 * 86_400_000);
    await expect(
      prepareDevelopmentEnvironment({ root, ownerApproved: true, publicUrl }),
    ).rejects.toThrow('Existing .env.dev.local is preserved');
    expect(await readFile(result.envPath, 'utf8')).toBe(contents);
  });

  it('preserves existing environment files and existing persistence without writes', async () => {
    for (const kind of ['environment', 'persistence']) {
      const root = await fixture();
      const marker = kind === 'environment' ? '.env.dev.local' : 'mountdata/dev/postgres/keep';
      if (kind === 'persistence')
        await mkdir(join(root, 'mountdata/dev/postgres'), { recursive: true });
      await writeFile(join(root, marker), 'preserve-original', { mode: 0o600 });
      const before = await files(root);
      await expect(
        prepareDevelopmentEnvironment({ root, ownerApproved: true, publicUrl }),
      ).rejects.toThrow('preserved');
      expect(await files(root)).toEqual(before);
      expect(await readFile(join(root, marker), 'utf8')).toBe('preserve-original');
    }
  });

  it('refuses symlinked roots, mount directories, environment files and noncanonical roots', async () => {
    for (const relative of ['mountdata', 'mountdata/dev', '.env.dev.local']) {
      const root = await fixture();
      const outside = await fixture();
      if (relative === 'mountdata/dev') await mkdir(join(root, 'mountdata'));
      await symlink(outside, join(root, relative));
      await expect(
        prepareDevelopmentEnvironment({ root, ownerApproved: true, publicUrl }),
      ).rejects.toThrow();
      expect(await readdir(outside)).toEqual([]);
    }
    const root = await fixture();
    const alias = join(root, 'alias');
    const outside = await fixture();
    await symlink(outside, alias);
    for (const unsafeRoot of [alias, `${outside}/../${outside.split('/').at(-1)}`])
      await expect(
        prepareDevelopmentEnvironment({ root: unsafeRoot, ownerApproved: true, publicUrl }),
      ).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it('fails clearly on an unwritable mountdata parent without changing its permissions', async () => {
    const root = await fixture();
    const mount = join(root, 'mountdata');
    await mkdir(mount, { mode: 0o500 });
    try {
      await expect(
        prepareDevelopmentEnvironment({ root, ownerApproved: true, publicUrl }),
      ).rejects.toThrow('separately approved scoped directory preparation');
      expect((await lstat(mount)).mode & 0o777).toBe(0o500);
      expect(await readdir(mount)).toEqual([]);
      expect(await readdir(root)).toEqual(['mountdata']);
    } finally {
      await chmod(mount, 0o700);
    }
  });

  it('permits an existing empty development directory without touching sibling state', async () => {
    const root = await fixture();
    await mkdir(join(root, 'mountdata/dev'), { recursive: true });
    await writeFile(join(root, 'mountdata/unrelated'), 'preserve-original');
    await prepareDevelopmentEnvironment({ root, ownerApproved: true, publicUrl });
    expect(await readFile(join(root, 'mountdata/unrelated'), 'utf8')).toBe('preserve-original');
  });

  it('permits only PostgreSQL mount traversal under umask 077 and never repairs existing state', async () => {
    const root = await fixture();
    // Changing umask in a Vitest worker is unsupported and would affect unrelated
    // tests. Exercise the real helper in a separate process confined to this temp root.
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { prepareDevelopmentEnvironment } = await import(process.argv[1]);
         process.umask(0o077);
         await prepareDevelopmentEnvironment({
           root: process.argv[2], ownerApproved: true, publicUrl: process.argv[3],
         });`,
        new URL('./prepare-dev-environment.mjs', import.meta.url).href,
        root,
        publicUrl,
      ],
      { timeout: 35_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    for (const directory of [
      'mountdata',
      'mountdata/dev',
      'mountdata/dev/postgres',
      'mountdata/dev/redis',
      'mountdata/dev/app',
      'mountdata/dev/app/content',
      'mountdata/dev/app/sources',
      'mountdata/dev/mail',
      'mountdata/dev/mail-tls',
    ]) {
      const expected = directory === 'mountdata/dev/postgres' ? 0o711 : 0o700;
      expect((await lstat(join(root, directory))).mode & 0o777, directory).toBe(expected);
    }
    const envPath = join(root, '.env.dev.local');
    const environment = await readFile(envPath, 'utf8');
    const postgres = join(root, 'mountdata/dev/postgres');
    await chmod(postgres, 0o700);
    await expect(
      prepareDevelopmentEnvironment({ root, ownerApproved: true, publicUrl }),
    ).rejects.toThrow('preserved');
    expect((await lstat(postgres)).mode & 0o777).toBe(0o700);
    expect(await readFile(envPath, 'utf8')).toBe(environment);
  });
});
