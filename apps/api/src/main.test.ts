import { createServer } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { httpServerPolicy } from './http-server.js';

const fixture = vi.hoisted(() => ({ close: vi.fn(async () => {}), log: vi.fn() }));
vi.mock('./runtime.js', () => ({
  createRuntime: async (env: Record<string, string | undefined>) => ({
    createDashboardIngress: () => {
      if (!env.NH_PUBLIC_URL?.startsWith('https://')) throw new Error('https_required');
      return { fetch: () => new Response('dashboard') };
    },
    app: { fetch: () => new Response('fixture') },
    close: fixture.close,
    logger: { log: fixture.log },
  }),
}));

import { main } from './main.js';

describe('API executable lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());
  it('rejects a real bind collision and closes resources without reporting startup', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, 'localhost', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    try {
      await expect(
        main({ NH_API_BIND_HOST: 'localhost', NH_API_PORT: String(address.port) }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(fixture.close).toHaveBeenCalledOnce();
      expect(fixture.log).not.toHaveBeenCalledWith('info', 'api.started');
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
  it('rejects missing listener configuration before opening resources', async () => {
    await expect(main({})).rejects.toMatchObject({ code: 'configuration_invalid' });
    await expect(main({ NH_API_BIND_HOST: 'localhost', NH_API_PORT: 'bad' })).rejects.toMatchObject(
      { code: 'configuration_invalid' },
    );
  });
  it('opens a separate dashboard listener only when enabled and releases the panel port on invalid configuration', async () => {
    async function freePort() {
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const address = probe.address();
      if (!address || typeof address === 'string') throw Error('Missing port');
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      return address.port;
    }
    const panel = await freePort(),
      dashboard = await freePort();
    const env = {
      NH_API_BIND_HOST: '127.0.0.1',
      NH_API_PORT: String(panel),
      NH_DASHBOARD_INGRESS_PORT: String(dashboard),
    };
    await expect(main({ ...env, NH_PUBLIC_URL: 'http://localhost' })).rejects.toThrow(
      'https_required',
    );
    const runtime = await main({ ...env, NH_PUBLIC_URL: 'https://panel.example.test' });
    try {
      expect(await (await fetch(`http://127.0.0.1:${dashboard}/v1/web/session`)).text()).toBe(
        'dashboard',
      );
      expect(await (await fetch(`http://127.0.0.1:${panel}/v1/web/session`)).text()).toBe(
        'fixture',
      );
    } finally {
      await runtime.stop();
    }
  });
  it('uses the guarded HTTP server in the actual executable listener', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const runtime = await main({
      NH_API_BIND_HOST: '127.0.0.1',
      NH_API_PORT: String(address.port),
    });
    try {
      expect(runtime.server.requestTimeout).toBe(0);
      expect(runtime.server.headersTimeout).toBe(httpServerPolicy.headersDeadlineMs);
      expect(runtime.server.timeout).toBe(httpServerPolicy.idleTimeoutMs);
      expect(await (await fetch(`http://127.0.0.1:${address.port}/fixture`)).text()).toBe(
        'fixture',
      );
    } finally {
      await runtime.stop();
    }
    expect(fixture.close).toHaveBeenCalledOnce();
  });
});
