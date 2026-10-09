import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveConfig } from '@nickhosting/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayRuntime, main } from './main.js';

const token = randomBytes(32).toString('base64url');
const id = randomUUID();
const env = {
  NH_GATEWAY_ID: id,
  NH_GATEWAY_CORE_URL: 'http://127.0.0.1:3999',
  NH_GATEWAY_CONTROL_TOKEN: token,
};
const configuration = {
  gatewayEnabled: true,
  gatewayId: id,
  gatewayPhysicalHostId: randomUUID(),
  gatewayLeaseSeconds: 3,
  gatewayObserver: {
    dockerSocket: '/fixture/docker.sock',
    hostProcDirectory: '/fixture/proc',
    expectedHostNamespaceId: 'net:[123]',
    expectedDockerDaemonId: 'fixture',
  },
  gatewayNetworkPolicy: {
    nodes: [{ nodeId: 1, nodeUuid: randomUUID(), networkMode: 'fixture' }],
    maximumObservationAgeMs: 5000,
  },
  gatewayDataPolicy: {
    ...resolveConfig().values.gatewayDataPolicy,
    pollIntervalMs: 100,
    probeIntervalMs: 100,
  },
};
const snapshot = () => {
  const issued = Date.now();
  return {
    gatewayId: id,
    revision: 1,
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + 3000).toISOString(),
    routes: [],
  };
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture() {
  let current = configuration;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(init?.redirect).toBe('error');
    const url = new URL(String(input));
    if (url.pathname.endsWith('/configuration')) return Response.json(current);
    if (url.pathname.endsWith('/snapshot')) return Response.json(snapshot());
    throw new Error('Unexpected control action');
  });
  return {
    fetcher,
    change: () => {
      current = { ...current, gatewayLeaseSeconds: 4 };
    },
  };
}
describe('separate permanent Gateway runtime composition', () => {
  it('authenticates configuration/snapshot requests and opens no implicit listeners', async () => {
    const f = fixture();
    const observe = vi.fn(async () => {
      throw new Error('No route needs a topology probe');
    });
    const runtime = await createGatewayRuntime(env, {
      fetcher: f.fetcher,
      protocols: [],
      observer: { observe },
    });
    cleanups.push(() => runtime.close());
    expect(runtime.gateway.ownedBindings()).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
    expect(runtime.gateway.health().controlAvailable).toBe(true);
    expect(f.fetcher).toHaveBeenCalled();
  });
  it('detects Owner policy changes and stops renewing the old runtime', async () => {
    const f = fixture();
    const runtime = await createGatewayRuntime(env, { fetcher: f.fetcher, protocols: [] });
    cleanups.push(() => runtime.close());
    f.change();
    await expect(runtime.gateway.refresh()).rejects.toThrow('configuration_invalid');
    expect(runtime.configurationChanged()).toBe(true);
    expect(runtime.gateway.health().controlAvailable).toBe(false);
  });
  it('fails closed when Core is unavailable at startup', async () => {
    await expect(
      createGatewayRuntime(env, {
        fetcher: async () => {
          throw new TypeError('fixture offline');
        },
      }),
    ).rejects.toThrow();
  });
  it('requires explicit valid bootstrap identity and encrypted or numeric-loopback control transport', async () => {
    for (const patch of [
      { NH_GATEWAY_ID: undefined },
      { NH_GATEWAY_CONTROL_TOKEN: undefined },
      { NH_GATEWAY_CORE_URL: 'http://panel.example.test' },
      { NH_GATEWAY_CONTROL_TOKEN: 'short' },
    ])
      await expect(createGatewayRuntime({ ...env, ...patch })).rejects.toThrow();
  });
  it('rejects remote/dynamic protocol module paths instead of executing configuration as code', async () => {
    const f = fixture();
    for (const paths of ['["https://example.test/unsafe.js"]', '["./relative.js"]', '{}'])
      await expect(
        createGatewayRuntime(
          { ...env, NH_GATEWAY_PROTOCOL_MODULES: paths },
          { fetcher: f.fetcher },
        ),
      ).rejects.toThrow();
  });
  it('keeps retrying an unavailable Core, recovers and shuts down idempotently', async () => {
    const f = fixture();
    let available = false;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (...args) => {
        if (!available) throw new Error('offline');
        return f.fetcher(...args);
      }),
    );
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const service = await main(
      {
        ...env,
        NH_GATEWAY_DATA_POLICY: JSON.stringify(configuration.gatewayDataPolicy),
      },
      { waitForLeaseDrain: async () => {} },
    );
    cleanups.push(() => service.close());
    expect(service.health().ready).toBe(false);
    available = true;
    for (let attempt = 0; attempt < 30 && !service.health().controlAvailable; attempt++)
      await delay(25);
    expect(service.health().controlAvailable).toBe(true);
    await service.close();
    await service.close();
    expect(service.health().stopping).toBe(true);
  });
  it('serves authenticated diagnostics over a private Unix socket without a public health port', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nh-gateway-health-'));
    cleanups.push(() => rm(directory, { recursive: true }));
    const socket = join(directory, 'health.sock');
    const f = fixture();
    vi.stubGlobal('fetch', f.fetcher);
    const service = await main(
      { ...env, NH_GATEWAY_DIAGNOSTICS_SOCKET: socket },
      { waitForLeaseDrain: async () => {} },
    );
    cleanups.push(() => service.close());
    async function get(path: string, authorization?: string) {
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          { socketPath: socket, path, headers: authorization ? { authorization } : {} },
          (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += String(chunk);
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    }
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    expect((await get('/metrics')).status).toBe(401);
    for (const path of ['/healthz', '/metrics']) {
      const r = await get(path, `Bearer ${token}`);
      expect(r.status).toBe(200);
      expect(r.body).not.toContain(token);
    }
    expect((await get('/unknown', `Bearer ${token}`)).status).toBe(404);
  });
  it('rejects any legacy diagnostic TCP bind instead of bypassing the game collision gate', async () => {
    await expect(
      main({ ...env, NH_GATEWAY_HEALTH_ADDRESS: '127.0.0.1', NH_GATEWAY_HEALTH_PORT: '3998' }),
    ).rejects.toThrow('configuration_invalid');
  });
});

it('quarantines a cold process before any control report or game forwarding and cancels on shutdown', async () => {
  const f = fixture();
  vi.stubGlobal('fetch', f.fetcher);
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
    expect(milliseconds).toBe(31000);
    entered();
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  });
  const service = await main(env, { waitForLeaseDrain: wait });
  cleanups.push(() => service.close());
  await pending;
  expect(service.health().ready).toBe(false);
  expect(f.fetcher).not.toHaveBeenCalled();
  await service.close();
  expect(f.fetcher).not.toHaveBeenCalled();
});
