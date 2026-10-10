import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, matchesGlob, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containerEnvironment } from '../deploy/container-env.mjs';

type Environment = 'development' | 'production';
const repository = resolve('.');

function deployment(environment: Environment): Record<string, string> {
  const prefix = environment === 'development' ? 'NH_DEV_' : 'NH_PROD_';
  return {
    NH_DEPLOYMENT_ENV: environment,
    [`${prefix}PUBLIC_URL`]: `https://${environment}.example.test`,
    [`${prefix}DB_PASSWORD`]: `database-${environment}-${'x'.repeat(32)}`,
    [`${prefix}REDIS_PASSWORD`]: `redis-${environment}-${'x'.repeat(32)}`,
    [`${prefix}MASTER_KEY`]: Buffer.alloc(32, environment === 'development' ? 17 : 19).toString(
      'base64',
    ),
    [`${prefix}AUTH_SECRET`]: `auth-${environment}-${'x'.repeat(32)}`,
    [`${prefix}SETUP_TOKEN`]: `setup-${environment}-${'x'.repeat(32)}`,
    ...(environment === 'development'
      ? {
          NH_DEV_SANDBOX_TOKEN: `sandbox-test-only-${'x'.repeat(32)}`,
          NH_DEV_MAIL_PASSWORD: `mail-test-only-${'x'.repeat(32)}`,
        }
      : {
          NH_PROD_APP_IMAGE: `example.test/nickhosting-app@sha256:${'1'.repeat(64)}`,
          NH_PROD_WEB_IMAGE: `example.test/nickhosting-web@sha256:${'2'.repeat(64)}`,
        }),
  };
}

describe('scoped container environment', () => {
  it.each(['development', 'production'] as const)(
    'constructs independent %s database/Redis/auth scope without mutating inputs',
    (environment) => {
      const input = Object.freeze(deployment(environment));
      const before = { ...input };
      const result = containerEnvironment(input);
      const scope = environment === 'development' ? 'dev' : 'prod';
      const prefix = `NH_${scope.toUpperCase()}_`;
      const database = new URL(result.DATABASE_URL);
      const redis = new URL(result.REDIS_URL);
      expect(database.hostname).toBe('postgres');
      expect(database.port).toBe('5432');
      expect(database.username).toBe(`nickhosting_${scope}`);
      expect(database.pathname).toBe(`/nickhosting_${scope}`);
      expect(decodeURIComponent(database.password)).toBe(input[`${prefix}DB_PASSWORD`]);
      expect(redis.hostname).toBe('redis');
      expect(redis.port).toBe('6379');
      expect(redis.pathname).toBe('/0');
      expect(result.NH_JOB_PREFIX).toBe(`nickhosting-${scope}`);
      expect(result.NH_SECRETS_KEY_ID).toBe(`${scope}-primary`);
      expect(result.BETTER_AUTH_SECRET).toBe(input[`${prefix}AUTH_SECRET`]);
      expect(result.NH_SETUP_TOKEN).toBe(input[`${prefix}SETUP_TOKEN`]);
      expect(result.NODE_ENV).toBe(environment);
      expect(result.NH_PUBLIC_URL).toBe(input[`${prefix}PUBLIC_URL`]);
      expect(result.NH_API_URL).toBe(result.NH_PUBLIC_URL);
      expect(result.NH_GATEWAY_ENABLED).toBe('false');
      expect(input).toEqual(before);
    },
  );

  it('requires an explicit environment and rejects cross-environment fields', () => {
    for (const value of [undefined, '', 'test', 'prod', 'Development'])
      expect(() =>
        containerEnvironment({ ...deployment('development'), NH_DEPLOYMENT_ENV: value }),
      ).toThrow(/environment/);
    expect(() =>
      containerEnvironment({ ...deployment('development'), NH_PROD_AUTH_SECRET: 'unused' }),
    ).toThrow(/prohibited/);
    expect(() =>
      containerEnvironment({ ...deployment('production'), NH_DEV_AUTH_SECRET: 'unused' }),
    ).toThrow(/prohibited/);
  });

  it.each(['development', 'production'] as const)(
    'rejects unscoped credential/coordination overrides in %s',
    (environment) => {
      for (const field of [
        'DATABASE_URL',
        'REDIS_URL',
        'BETTER_AUTH_SECRET',
        'NH_SECRETS_MASTER_KEY',
        'NH_SETUP_TOKEN',
        'NH_JOB_PREFIX',
      ])
        expect(() =>
          containerEnvironment({ ...deployment(environment), [field]: 'private-value' }),
        ).toThrow(`instead of ${field}`);
    },
  );

  it('requires both production artifact digests instead of mutable tags or placeholder digests', () => {
    for (const field of ['NH_PROD_APP_IMAGE', 'NH_PROD_WEB_IMAGE']) {
      for (const image of [
        undefined,
        'example.test/nickhosting:latest',
        `example.test/nickhosting@sha256:${'0'.repeat(64)}`,
        `example.test/nickhosting@sha256:${'1'.repeat(63)}`,
      ])
        expect(() => containerEnvironment({ ...deployment('production'), [field]: image })).toThrow(
          /Immutable reviewed image|Invalid deployment field/,
        );
    }
  });

  it('requires every scoped secret and rejects placeholders without echoing their value', () => {
    for (const [environment, prefix] of [
      ['development', 'NH_DEV_'],
      ['production', 'NH_PROD_'],
    ] as const) {
      const fields = ['DB_PASSWORD', 'REDIS_PASSWORD', 'MASTER_KEY', 'AUTH_SECRET', 'SETUP_TOKEN'];
      if (environment === 'development') fields.push('SANDBOX_TOKEN', 'MAIL_PASSWORD');
      for (const field of fields) {
        for (const invalid of [
          undefined,
          '',
          'short',
          ' '.repeat(40),
          `CHANGE_ME_${'x'.repeat(40)}`,
          `replace_${'x'.repeat(40)}`,
          `generate_${'x'.repeat(40)}`,
        ]) {
          let message: string | undefined;
          try {
            containerEnvironment({ ...deployment(environment), [`${prefix}${field}`]: invalid });
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message, `${environment}:${field}`).toBeDefined();
          if (invalid) expect(message).not.toContain(invalid);
        }
      }
    }
  });

  it('requires a canonical 32-byte base64 encryption key and distinct credentials', () => {
    for (const key of [
      Buffer.alloc(31, 17).toString('base64'),
      Buffer.alloc(33, 17).toString('base64'),
      `${Buffer.alloc(32, 17).toString('base64')}\n`,
      'not-a-base64-key'.repeat(3),
    ])
      expect(() =>
        containerEnvironment({ ...deployment('production'), NH_PROD_MASTER_KEY: key }),
      ).toThrow(/Master key|MASTER_KEY/);
    const input = deployment('development');
    for (const field of [
      'REDIS_PASSWORD',
      'AUTH_SECRET',
      'SETUP_TOKEN',
      'SANDBOX_TOKEN',
      'MAIL_PASSWORD',
    ])
      expect(() =>
        containerEnvironment({ ...input, [`NH_DEV_${field}`]: input.NH_DEV_DB_PASSWORD }),
      ).toThrow(/independent/);
  });

  it('encodes URL-reserved password characters without changing connection hosts', () => {
    const password = `test-only:@/%?#[]${'x'.repeat(32)}`;
    const result = containerEnvironment({
      ...deployment('production'),
      NH_PROD_DB_PASSWORD: password,
      NH_PROD_REDIS_PASSWORD: `redis-${password}`,
    });
    expect(new URL(result.DATABASE_URL).hostname).toBe('postgres');
    expect(decodeURIComponent(new URL(result.DATABASE_URL).password)).toBe(password);
    expect(new URL(result.REDIS_URL).hostname).toBe('redis');
    expect(decodeURIComponent(new URL(result.REDIS_URL).password)).toBe(`redis-${password}`);
  });

  it('never permits disabling TLS verification', () => {
    for (const environment of ['development', 'production'] as const)
      expect(() =>
        containerEnvironment({ ...deployment(environment), NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
      ).toThrow(/TLS verification/);
    expect(
      containerEnvironment({ ...deployment('production'), NODE_TLS_REJECT_UNAUTHORIZED: '1' })
        .NODE_TLS_REJECT_UNAUTHORIZED,
    ).toBe('1');
  });

  it.each([
    'http://panel.example.test',
    'https://panel.example.test:8443',
    'https://panel.example.test/path',
    'https://panel.example.test/?redirect=anywhere',
    'https://panel.example.test/#fragment',
    'https://user:private-password@panel.example.test',
    'https://*.example.test',
    'https://.example.test',
  ])('rejects a non-exact HTTPS origin', (url) => {
    expect(() =>
      containerEnvironment({ ...deployment('production'), NH_PROD_PUBLIC_URL: url }),
    ).toThrow(/Public URL/);
  });

  it('normalizes explicit HTTPS port 443 while preserving the exact origin', () => {
    expect(
      containerEnvironment({
        ...deployment('production'),
        NH_PROD_PUBLIC_URL: 'https://panel.example.test:443/',
      }).NH_PUBLIC_URL,
    ).toBe('https://panel.example.test');
  });

  it('forces local sandbox/mail providers and disables external downloads in development', () => {
    const input = deployment('development');
    const result = containerEnvironment({
      ...input,
      NODE_ENV: 'production',
    });
    expect(result.NH_PTERODACTYL_BASE_URL).toBe('http://provider:9090');
    expect(result.NH_PTERODACTYL_APPLICATION_KEY).toBe(input.NH_DEV_SANDBOX_TOKEN);
    expect(result.NH_PTERODACTYL_CLIENT_KEY).toBe(input.NH_DEV_SANDBOX_TOKEN);
    expect(result.NH_SFTPGO_BASE_URL).toBe('http://provider:9090');
    expect(result.NH_SFTPGO_API_KEY).toBe('development-disabled');
    expect(result.NH_CLOUDFLARE_API_TOKEN).toBe('development-disabled');
    expect(result.NH_CURSEFORGE_API_KEY).toBe('development-disabled');
    expect(result.SMTP_HOST).toBe('mailpit');
    expect(result.SMTP_PORT).toBe('1025');
    expect(result.SMTP_PASSWORD).toBe(input.NH_DEV_MAIL_PASSWORD);
    expect(result.NODE_EXTRA_CA_CERTS).toBe('/run/dev-mail/cert.pem');
    expect(result.NH_MINECRAFT_DOWNLOAD_ORIGINS).toBe('[]');
    expect(result.NH_PTERODACTYL_WEBSOCKET_ORIGINS).toBe('[]');
    expect(result.NH_PTERODACTYL_DOWNLOAD_ORIGINS).toBe('[]');
    expect(result.NH_PTERODACTYL_UPLOAD_ORIGINS).toBe('[]');
    expect(result.NH_MINECRAFT_CONTENT_ROOT).toBe('./mountdata/content');
    expect(result.NH_MINECRAFT_SOURCE_ROOT).toBe('./mountdata/sources');
    expect(Object.values(result).join('\n')).not.toContain('unused-production');
  });

  it('rejects direct production-provider credentials and observer configuration in development', () => {
    for (const field of [
      'NH_PTERODACTYL_BASE_URL',
      'NH_PTERODACTYL_APPLICATION_KEY',
      'NH_PTERODACTYL_CLIENT_KEY',
      'NH_SFTPGO_BASE_URL',
      'NH_SFTPGO_API_KEY',
      'NH_CLOUDFLARE_API_TOKEN',
      'DISCORD_CLIENT_SECRET',
      'SMTP_HOST',
      'SMTP_PASSWORD',
      'NH_DOCKER_OBSERVER_SOCKET',
      'NH_GATEWAY_ENABLED',
      'NH_PUBLIC_URL',
      'NH_API_URL',
      'NH_MINECRAFT_CONTENT_ROOT',
      'NH_MINECRAFT_SOURCE_ROOT',
      'NH_CURSEFORGE_API_KEY',
      'NH_MINECRAFT_DOWNLOAD_ORIGINS',
    ])
      expect(() =>
        containerEnvironment({ ...deployment('development'), [field]: 'private-value' }),
      ).toThrow(`development: ${field}`);
  });
});

describe('deployment artifact boundaries', () => {
  it.each(['dev', 'prod'])(
    'keeps all %s ingress module temporary files on its writable tmpfs',
    async (mode) => {
      const template = await readFile(
        resolve(repository, `deploy/nginx/${mode}.conf.template`),
        'utf8',
      );
      for (const kind of ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']) {
        expect(template).toMatch(new RegExp(`${kind}_temp_path /tmp/[a-z_]+;`));
      }
      expect(template).not.toContain('/var/cache/nginx');
    },
  );

  it('normalizes the exact ingress hostname and substitutes only its intended variable', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nickhosting-ingress-test-'));
    try {
      await mkdir(resolve(root, 'bin'));
      await mkdir(resolve(root, 'conf'));
      // Redirect fixed container paths into this fixture. Keep shell validation
      // and arguments intact; the two external programs below never bind listeners.
      const script = (await readFile(resolve(repository, 'deploy/nginx/start.sh'), 'utf8'))
        .replaceAll('/opt/nickhosting', resolve(root, 'conf'))
        .replaceAll('/tmp/nginx.conf', resolve(root, 'nginx.conf'));
      await writeFile(resolve(root, 'start.sh'), script);
      await cp(
        resolve(repository, 'deploy/nginx/dev.conf.template'),
        resolve(root, 'conf/nginx.conf.template'),
      );
      const publicHostVariable = `\${NH_PUBLIC_HOST}`;
      await writeFile(
        resolve(root, 'bin/envsubst'),
        `#!${process.execPath}\n` +
          "const fs = require('node:fs');\n" +
          `if (process.argv[2] !== ${JSON.stringify(publicHostVariable)}) process.exit(9);\n` +
          `process.stdout.write(fs.readFileSync(0, 'utf8').replaceAll(${JSON.stringify(publicHostVariable)}, process.env.NH_PUBLIC_HOST));\n`,
        { mode: 0o755 },
      );
      await writeFile(
        resolve(root, 'bin/nginx'),
        `#!${process.execPath}\n` +
          "require('node:fs').appendFileSync(process.env.TEST_NGINX_TRACE, JSON.stringify(process.argv.slice(2)) + '\\n');\n",
        { mode: 0o755 },
      );
      const env = {
        PATH: `${resolve(root, 'bin')}:${process.env.PATH ?? ''}`,
        TEST_NGINX_TRACE: resolve(root, 'trace.jsonl'),
        NH_PUBLIC_URL: 'https://Panel.Example.Test:443/',
      };
      const started = spawnSync('/bin/sh', [resolve(root, 'start.sh')], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 3000,
      });
      expect(started.status, started.stderr).toBe(0);
      const configured = await readFile(resolve(root, 'nginx.conf'), 'utf8');
      expect(configured).toContain('server_name panel.example.test;');
      expect(configured).not.toContain(publicHostVariable);
      expect(configured).toContain('$http_upgrade');
      expect(configured).toContain('$connection_upgrade');
      const trace = (await readFile(env.TEST_NGINX_TRACE, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(trace).toEqual([
        ['-t', '-c', resolve(root, 'nginx.conf')],
        ['-c', resolve(root, 'nginx.conf'), '-g', 'daemon off;'],
      ]);
      for (const invalid of [
        'http://panel.example.test',
        'https://panel.example.test:8443',
        'https://panel.example.test/path',
        'https://*.example.test',
        'https://user:private-password@panel.example.test',
        'https://panel.example.test;echo bad',
      ]) {
        const rejected = spawnSync('/bin/sh', [resolve(root, 'start.sh')], {
          cwd: root,
          env: { ...env, NH_PUBLIC_URL: invalid },
          encoding: 'utf8',
          timeout: 3000,
        });
        expect(rejected.status).toBe(1);
        expect(rejected.stderr).not.toContain(invalid);
      }
      expect((await readFile(env.TEST_NGINX_TRACE, 'utf8')).trim().split('\n')).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown service roles and production Vite before launching an application', () => {
    for (const role of ['web', 'unrecognized']) {
      const marker = 'private-fixture-value-that-must-not-appear';
      const result = spawnSync(process.execPath, ['deploy/container-entry.mjs', role], {
        cwd: repository,
        env: {
          PATH: process.env.PATH,
          NH_DEPLOYMENT_ENV: 'production',
          NH_PROD_AUTH_SECRET: marker,
        },
        encoding: 'utf8',
        timeout: 3000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Vite is prohibited in production|Unknown service role/);
      expect(result.stderr).not.toContain(marker);
      expect(result.stdout).toBe('');
    }
  });

  it('allows build sources but excludes private inputs, credentials, output and archives', async () => {
    const rules = (await readFile(resolve(repository, '.dockerignore'), 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    // This allowlist deliberately uses only ** globs and !negation, whose matching
    // is shared by these fixture paths and Docker. No Docker resource is needed.
    const included = (path: string) => {
      let accepted = true;
      for (const rule of rules) {
        const include = rule.startsWith('!');
        const pattern = (include ? rule.slice(1) : rule).replace(/\/$/, '');
        if (matchesGlob(path, pattern)) accepted = include;
      }
      return accepted;
    };
    for (const path of [
      'package.json',
      'pnpm-lock.yaml',
      'apps/api/src/main.ts',
      'apps/web/src/app/app.tsx',
      'packages/database/migrations/001.sql',
      'games/minecraft/src/ui/assets/minecraft-landscape.svg',
      'deploy/container-entry.mjs',
      'scripts/build-runtime.mjs',
    ])
      expect(included(path), path).toBe(true);
    for (const path of [
      '.env',
      '.env.m2.local',
      '.codex/local/INFRASTRUCTURE.md',
      '.git/config',
      'mountdata/test-assets/ledger.json',
      'starter.zip',
      'apps/api/.env.production',
      'apps/api/mountdata/secrets.json',
      'apps/api/node_modules/library/index.js',
      'apps/web/dist/assets/index.js',
      'apps/web/test-results/account.png',
      'apps/web/playwright-report/index.html',
      'games/minecraft/private.key',
      'deploy/prod/fullchain.pem',
      'deploy/prod/private.log',
      'deploy/prod/snapshot.tar.gz',
      'deploy/prod/credentials.bak',
    ])
      expect(included(path), path).toBe(false);
  });

  it('builds executable JS and reviewed SQL assets without copying source secrets or test code', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nickhosting-artifact-test-'));
    const put = async (path: string, contents: string) => {
      await mkdir(dirname(resolve(root, path)), { recursive: true });
      await writeFile(resolve(root, path), contents);
    };
    try {
      await cp(resolve(repository, 'tsconfig.json'), resolve(root, 'tsconfig.json'));
      await cp(
        resolve(repository, 'tsconfig.runtime.json'),
        resolve(root, 'tsconfig.runtime.json'),
      );
      await symlink(resolve(repository, 'node_modules'), resolve(root, 'node_modules'), 'dir');
      await put('package.json', '{"private":true,"type":"module"}\n');
      await put('pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');
      await put('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n  - games/*\n');
      for (const name of ['apps/api', 'packages/database', 'games/fixture']) {
        await put(
          `${name}/package.json`,
          JSON.stringify({
            name: `fixture-${name.replace('/', '-')}`,
            private: true,
            type: 'module',
            exports: {
              '.': './src/index.ts',
              './nested': { import: './src/index.ts' },
              './testing': './src/testing.ts',
            },
          }),
        );
        await put(`${name}/src/index.ts`, 'export const compiled: number = 1;\n');
        await put(`${name}/src/private.test.ts`, 'throw new Error("test-only must not ship");\n');
        await put(`${name}/src/testing.ts`, 'export const testHelper = "must not ship";\n');
        await put(`${name}/src/test-fixtures.ts`, 'export const fixture = "must not ship";\n');
        await put(`${name}/src/testing/fixture.ts`, 'export const nested = "must not ship";\n');
        await put(`${name}/.env`, 'PRIVATE_BUILD_SENTINEL=never-copy\n');
      }
      await put('packages/database/migrations/001.sql', 'SELECT 1;\n');
      await put('mountdata/database/private.txt', 'private persistence must not ship\n');
      await put('.codex/local/private.txt', 'private notes must not ship\n');
      await put('.env.production', 'SECRET_SENTINEL=never-copy\n');
      await mkdir(resolve(root, 'deploy'));
      for (const file of ['container-entry.mjs', 'container-env.mjs', 'container-health.mjs'])
        await cp(resolve(repository, 'deploy', file), resolve(root, 'deploy', file));
      await put('deploy/dev-provider.mjs', 'throw new Error("sandbox must not ship");\n');
      const output: Buffer[] = [];
      const child = spawn(process.execPath, [resolve(repository, 'scripts/build-runtime.mjs')], {
        cwd: root,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
      const status = await new Promise<number | null>((resolveStatus, reject) => {
        child.once('error', reject);
        child.once('close', resolveStatus);
      });
      expect(status, Buffer.concat(output).toString('utf8')).toBe(0);
      const files = await readdir(resolve(root, 'build/runtime'), { recursive: true });
      expect(files).toContain('apps/api/src/index.js');
      expect(files).toContain('packages/database/migrations/001.sql');
      expect(files).toContain('games/fixture/src/index.js');
      expect(files).toContain('deploy/container-env.mjs');
      expect(
        files.some((file) =>
          /\.tsx?$|\.map$|\.env|private|dev-provider|testing|test-fixtures/.test(file),
        ),
      ).toBe(false);
      expect(files).not.toContain('mountdata');
      expect(files).not.toContain('.codex');
      const manifest = JSON.parse(
        await readFile(resolve(root, 'build/runtime/games/fixture/package.json'), 'utf8'),
      );
      expect(manifest.exports).toEqual({
        '.': './src/index.js',
        './nested': { import: './src/index.js' },
      });
      expect(await readFile(resolve(root, '.env.production'), 'utf8')).toContain('SECRET_SENTINEL');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

type ComposeService = {
  environment?: Record<string, string>;
  image: string;
  ports?: unknown[];
  networks?: Record<string, unknown>;
  network_mode?: string;
  privileged?: boolean;
  command?: string[];
  entrypoint?: string[];
  profiles?: string[];
  restart?: string;
  volumes?: Array<{
    type: string;
    source: string;
    target: string;
    read_only?: boolean;
    bind?: { create_host_path?: boolean };
  }>;
};
type ComposeConfiguration = {
  name: string;
  services: Record<string, ComposeService>;
  networks: Record<string, { name: string; internal?: boolean; external?: boolean }>;
};

// Parse examples only: no .env auto-discovery and no inherited deployment/provider keys.
// `compose config` is read-only and never connects to or creates Docker resources.
function composeConfiguration(scope: 'dev' | 'prod'): ComposeConfiguration {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(NH_|DATABASE_URL$|REDIS_URL$|BETTER_AUTH_|POSTGRES_|SMTP_|DISCORD_|COMPOSE_)/.test(key),
    ),
  );
  const parsed = spawnSync(
    'docker',
    [
      'compose',
      '--profile',
      '*',
      '--env-file',
      `deploy/${scope}/.env.example`,
      '-f',
      `compose.${scope}.yaml`,
      'config',
      '--format',
      'json',
    ],
    { cwd: repository, env: environment, encoding: 'utf8', timeout: 15_000 },
  );
  expect(parsed.error).toBeUndefined();
  expect(parsed.status, parsed.stderr).toBe(0);
  return JSON.parse(parsed.stdout) as ComposeConfiguration;
}

describe('deployment Compose isolation (read-only configuration parsing)', () => {
  it.each(['dev', 'prod'] as const)(
    'publishes no %s host ports and attaches only ingress to the pre-existing external network',
    (scope) => {
      const configuration = composeConfiguration(scope);
      expect(configuration.name).toBe(`nickhosting-${scope}`);
      expect(configuration.networks.frontend?.external).toBe(true);
      expect(configuration.networks.edge?.internal).toBe(true);
      expect(configuration.networks.data?.internal).toBe(true);
      expect(configuration.networks.edge?.name).toBe(`nickhosting-${scope}-edge`);
      expect(configuration.networks.data?.name).toBe(`nickhosting-${scope}-data`);
      for (const [name, service] of Object.entries(configuration.services)) {
        expect(service.ports ?? [], name).toEqual([]);
        expect(service.network_mode, name).toBeUndefined();
        expect(service.privileged, name).not.toBe(true);
        expect(Object.keys(service.networks ?? {}).includes('frontend'), name).toBe(name === 'web');
        for (const volume of service.volumes ?? []) {
          expect(volume.type, name).toBe('bind');
          expect(volume.bind?.create_host_path, name).not.toBe(true);
          expect(volume.source, name).not.toMatch(/docker\.sock|\/var\/lib\/docker|\/wings\//);
          if (volume.target.startsWith('/app/mountdata') || !volume.target.startsWith('/app/'))
            expect(volume.source.startsWith(resolve(repository, `mountdata/${scope}/`)), name).toBe(
              true,
            );
        }
      }
      expect(configuration.services.migrate?.profiles).toEqual(['tools']);
      expect(configuration.services.migrate?.restart).toBe('no');
      expect(configuration.services.api?.command).toEqual(['api']);
      expect(configuration.services.worker?.command).toEqual(['worker']);
      expect(Object.keys(configuration.services)).not.toContain('gateway');
    },
  );

  it('keeps development source mounts below workspace manifests and browser services free of secrets', () => {
    const { services, networks } = composeConfiguration('dev');
    expect(Object.keys(networks).sort()).toEqual(['data', 'edge', 'frontend']);
    const vite = services.vite;
    expect(vite).toBeDefined();
    expect(vite?.environment).toMatchObject({
      NH_DEPLOYMENT_ENV: 'development',
      NH_WEB_BIND_HOST: '0.0.0.0',
      NH_WEB_PORT: '5173',
      NH_WEB_EXTERNAL_HTTPS: '1',
      NH_WEB_CACHE_DIR: '/tmp/vite-cache',
    });
    expect(vite?.command).toEqual(['web']);
    for (const name of ['web', 'vite']) {
      const environment = services[name]?.environment ?? {};
      expect(
        Object.keys(environment).some((key) =>
          /PASSWORD|SECRET|TOKEN|KEY|DATABASE|REDIS/.test(key),
        ),
      ).toBe(false);
      expect(Object.values(environment).join('\n')).not.toMatch(/GENERATE_|REPLACE_/);
    }
    expect(services.provider?.environment).toEqual({
      NH_DEV_SANDBOX_TOKEN: 'GENERATE_UNIQUE_DEV_SANDBOX_TOKEN_32_BYTES',
    });
    expect(Object.keys(services.worker?.networks ?? {})).toEqual(['data']);
    expect(Object.keys(services.provider?.networks ?? {})).toEqual(['data']);
    for (const name of ['api', 'worker', 'vite']) {
      for (const volume of services[name]?.volumes ?? []) {
        if (!volume.target.startsWith('/app/') || volume.target.startsWith('/app/mountdata'))
          continue;
        expect(volume.target).toMatch(
          /^\/app\/(?:apps\/web\/(?:index\.html|vite(?:-network|\.config)\.ts)|scripts\/compile-web-i18n\.ts|tsconfig\.json|(?:apps|packages|games)\/[^/]+\/src)$/,
        );
        expect(volume.target).not.toContain('node_modules');
        expect(volume.read_only ?? false).toBe(volume.target !== '/app/apps/web/src');
      }
    }
    expect(services.mailpit?.environment?.MP_SMTP_REQUIRE_STARTTLS).toBe('true');
    expect(services.mailpit?.environment?.MP_SMTP_AUTH_FILE).toBe('/run/mail-tls/smtp-auth');
  });

  it('uses immutable production artifacts without source binds, Vite, provider sandbox or development inputs', () => {
    const { services } = composeConfiguration('prod');
    for (const name of ['vite', 'provider', 'mailpit']) expect(services[name]).toBeUndefined();
    for (const [name, service] of Object.entries(services)) {
      expect(service.image, name).toMatch(/@sha256:[a-f0-9]{64}$/);
      expect(Object.keys(service.environment ?? {}).some((key) => key.startsWith('NH_DEV_'))).toBe(
        false,
      );
      for (const volume of service.volumes ?? [])
        expect(volume.source.startsWith(resolve(repository, 'mountdata/prod/')), name).toBe(true);
    }
    expect(Object.keys(services.web?.environment ?? {})).toEqual(['NH_PUBLIC_URL']);
    expect(Object.keys(services.worker?.networks ?? {}).sort()).toEqual(['data', 'egress']);
  });

  it('rejects the committed placeholder examples as actual startup environments', async () => {
    for (const scope of ['dev', 'prod'] as const) {
      const sample = await readFile(resolve(repository, `deploy/${scope}/.env.example`), 'utf8');
      const values = Object.fromEntries(
        sample
          .split('\n')
          .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
      expect(() =>
        containerEnvironment({
          ...values,
          NH_DEPLOYMENT_ENV: scope === 'dev' ? 'development' : 'production',
        }),
      ).toThrow(/Invalid deployment field|Immutable reviewed image/);
    }
  });
});
