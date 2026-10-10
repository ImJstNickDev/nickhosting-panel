import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gatewayHealth } from '../deploy/gateway-health.mjs';

const token = 'fixture-gateway-token-'.padEnd(43, 'x');
async function withSocket(handler: RequestListener, run: (socketPath: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nh-gateway-health-'));
  const socketPath = join(directory, 'health.sock');
  const server = createServer(handler);
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(socketPath, done);
    });
    await run(socketPath);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}

describe('dedicated Gateway diagnostics', () => {
  it('authenticates readiness over a private Unix socket', async () => {
    await withSocket(
      (request, response) => {
        expect(request.method).toBe('GET');
        expect(request.url).toBe('/readyz');
        expect(request.headers.authorization).toBe(`Bearer ${token}`);
        response.end(JSON.stringify({ ready: true, controlAvailable: true }));
      },
      async (socketPath) => {
        expect(
          await gatewayHealth({
            NH_GATEWAY_DIAGNOSTICS_SOCKET: socketPath,
            NH_GATEWAY_CONTROL_TOKEN: token,
          }),
        ).toBe(true);
      },
    );
  });

  it.each([
    [503, '{"ready":true,"controlAvailable":true}'],
    [401, '{}'],
    [302, '{"ready":true,"controlAvailable":true}'],
    [200, '{"ready":false,"controlAvailable":true}'],
    [200, '{"ready":true,"controlAvailable":false}'],
    [200, '{}'],
    [200, 'invalid'],
    [200, 'x'.repeat(16385)],
  ])('fails closed for status %s and unavailable/malformed responses', async (status, body) => {
    await withSocket(
      (_request, response) => response.writeHead(status).end(body),
      async (socketPath) => {
        expect(
          await gatewayHealth({
            NH_GATEWAY_DIAGNOSTICS_SOCKET: socketPath,
            NH_GATEWAY_CONTROL_TOKEN: token,
          }),
        ).toBe(false);
      },
    );
  });

  it('rejects missing credentials, network URLs and absent sockets', async () => {
    for (const env of [
      {},
      { NH_GATEWAY_DIAGNOSTICS_SOCKET: '/tmp/unused.sock' },
      { NH_GATEWAY_DIAGNOSTICS_SOCKET: 'http://127.0.0.1:1234', NH_GATEWAY_CONTROL_TOKEN: token },
      { NH_GATEWAY_DIAGNOSTICS_SOCKET: '/tmp/unused.sock', NH_GATEWAY_CONTROL_TOKEN: 'short' },
      {
        NH_GATEWAY_DIAGNOSTICS_SOCKET: '/does-not-exist/nickhosting-gateway.sock',
        NH_GATEWAY_CONTROL_TOKEN: token,
      },
    ])
      expect(await gatewayHealth(env)).toBe(false);
  });
});

type Service = {
  environment?: Record<string, string>;
  env_file?: unknown;
  image?: string;
  profiles?: string[];
  network_mode?: string;
  networks?: Record<string, unknown>;
  ports?: unknown[];
  privileged?: boolean;
  user?: string;
  group_add?: string[];
  cap_drop?: string[];
  read_only?: boolean;
  security_opt?: string[];
  tmpfs?: string[];
  entrypoint?: string[];
  volumes?: {
    source: string;
    target: string;
    read_only?: boolean;
    bind?: { create_host_path?: boolean };
  }[];
};
function compose(gateway: boolean) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(NH_|DATABASE_URL$|REDIS_URL$|BETTER_AUTH_|POSTGRES_|SMTP_|DISCORD_|COMPOSE_)/.test(key),
    ),
  );
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--profile',
      '*',
      '--env-file',
      'deploy/dev/.env.example',
      '-f',
      'compose.dev.yaml',
      '-f',
      'compose.dev.real.yaml',
      '-f',
      'compose.dev.observer.yaml',
      ...(gateway ? ['-f', 'compose.dev.gateway.yaml'] : []),
      'config',
      '--format',
      'json',
    ],
    {
      // Read-only parser only; no Docker daemon connections or infrastructure mutations.
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...env,
        NH_DEV_PUBLIC_URL: 'https://dev.hub.example.test',
        NH_DEV_GATEWAY_ID: '60c8c57e-ae42-4ad6-906d-04c22f70ff2c',
        NH_DEV_GATEWAY_CONTROL_TOKEN: token,
        NH_DEV_GATEWAY_HOST_PROC: '/proc/12345',
        NH_DEV_DOCKER_GID: '987',
        NH_DEV_PHYSICAL_HOST_ID: 'test-host',
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    name: string;
    services: Record<string, Service>;
    networks: unknown;
  };
}

describe('opt-in development Gateway Compose', () => {
  it('adds only the host-network service and explicit Core enablement without new networks', () => {
    const baseline = compose(false);
    const enabled = compose(true);
    expect(enabled.name).toBe('nickhosting-dev');
    expect(enabled.networks).toEqual(baseline.networks);
    expect(Object.keys(enabled.services).filter((name) => !baseline.services[name])).toEqual([
      'gateway',
    ]);
    for (const [name, service] of Object.entries(baseline.services)) {
      const actual = enabled.services[name];
      if (['api', 'worker'].includes(name)) {
        expect(actual).toEqual({
          ...service,
          environment: {
            ...service.environment,
            NH_DEV_GATEWAY_ENABLED: 'true',
            NH_DEV_GATEWAY_ID: '60c8c57e-ae42-4ad6-906d-04c22f70ff2c',
            NH_DEV_GATEWAY_CONTROL_TOKEN: token,
          },
        });
      } else expect(actual).toEqual(service);
    }
    const gateway = enabled.services.gateway;
    expect(gateway?.profiles).toEqual(['gateway']);
    expect(gateway?.image).toBe('nickhosting-dev-app:local');
    expect(gateway?.network_mode).toBe('host');
    expect(gateway?.networks).toBeUndefined();
    expect(gateway?.ports ?? []).toEqual([]);
    expect(gateway?.privileged).not.toBe(true);
    expect(gateway?.read_only).toBe(true);
    expect(gateway?.user).toBe('1000:1000');
    expect(gateway?.group_add).toEqual(['987']);
    expect(gateway?.cap_drop).toEqual(['ALL']);
    expect(gateway?.security_opt).toEqual(['no-new-privileges:true']);
  });

  it('passes only dedicated bootstrap credentials and mounts no database/provider/private state', () => {
    const gateway = compose(true).services.gateway;
    expect(gateway?.environment).toEqual({
      NH_GATEWAY_ID: '60c8c57e-ae42-4ad6-906d-04c22f70ff2c',
      NH_GATEWAY_CONTROL_TOKEN: token,
      NH_GATEWAY_CORE_URL: 'https://dev.hub.example.test',
      NH_GATEWAY_DIAGNOSTICS_SOCKET: '/run/nickhosting-gateway/diagnostics.sock',
      NH_GATEWAY_PROTOCOL_MODULES: '["/app/games/minecraft/src/gateway-module.ts"]',
    });
    expect(gateway?.env_file).toBeUndefined();
    expect(gateway?.entrypoint).toEqual([
      'node',
      '--import',
      'tsx',
      '/app/apps/game-gateway/src/main.ts',
    ]);
    expect(gateway?.tmpfs).toContain(
      '/run/nickhosting-gateway:rw,noexec,nosuid,size=1m,mode=0700,uid=1000,gid=1000',
    );
    expect(gateway?.volumes).toContainEqual({
      type: 'bind',
      source: '/proc/12345',
      target: '/run/nickhosting-host-proc',
      read_only: true,
      bind: { create_host_path: false },
    });
    for (const volume of gateway?.volumes ?? []) {
      expect(volume.read_only).toBe(true);
      expect(volume.bind?.create_host_path).toBe(false);
      expect(volume.source).not.toMatch(/mountdata|\.env|\.codex|wings|\/var\/lib\/docker/);
      if (!['/var/run/docker.sock', '/proc/12345'].includes(volume.source))
        expect(volume.source.startsWith(`${resolve('.')}/`)).toBe(true);
    }
  });
});
