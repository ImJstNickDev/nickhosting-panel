import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { loadConfigFromFile, mergeConfig } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { developmentNetwork, developmentWebSocketPath } from './vite-network.js';

describe('development Vite transport', () => {
  it('preserves loopback defaults and the browser harness custom WebSocket server', () => {
    const network = developmentNetwork({ NH_PUBLIC_URL: 'https://panel.example.test' });
    expect(network).toEqual({ host: '127.0.0.1', port: 5173, strictPort: true });
    const listener = createServer();
    const merged = mergeConfig(
      { server: network },
      { server: { middlewareMode: true, hmr: false, ws: { server: listener, clientPort: 49152 } } },
    );
    expect(merged.server.ws.server).toBe(listener);
    expect(merged.server.ws.clientPort).toBe(49152);
    expect(merged.server.ws.protocol).toBeUndefined();
    expect(listener.listening).toBe(false);
  });

  it('uses one container listener and an exact HTTPS ingress for browser WebSockets', () => {
    const network = developmentNetwork({
      NH_WEB_BIND_HOST: '0.0.0.0',
      NH_WEB_PORT: '5173',
      NH_WEB_EXTERNAL_HTTPS: '1',
      NH_PUBLIC_URL: 'https://review.example.test:443/',
    });
    expect(network).toEqual({
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts: ['review.example.test'],
      origin: 'https://review.example.test',
      cors: { origin: 'https://review.example.test' },
      ws: {
        protocol: 'wss',
        host: 'review.example.test',
        clientPort: 443,
        path: developmentWebSocketPath,
      },
    });
    expect(network.ws).not.toHaveProperty('port');
  });

  it.each([
    undefined,
    'http://review.example.test',
    'https://review.example.test:8443',
    'https://review.example.test/path',
    'https://review.example.test?secret=value',
    'https://review.example.test/#fragment',
    'https://user:password@review.example.test',
    'https://.example.test',
    'https://*.example.test',
    'https://127.0.0.1',
    'https://[::1]',
    'https://localhost',
    'https://sub.localhost',
  ])('rejects an ambiguous external origin without reflecting its value', (origin) => {
    expect(() => developmentNetwork({ NH_WEB_EXTERNAL_HTTPS: '1', NH_PUBLIC_URL: origin })).toThrow(
      /NH_PUBLIC_URL/,
    );
  });

  it('rejects host wildcards, invalid ports, mode typos and ambient additional host grants', () => {
    for (const host of ['true', '*', 'localhost', 'container.internal'])
      expect(() => developmentNetwork({ NH_WEB_BIND_HOST: host })).toThrow(/NH_WEB_BIND_HOST/);
    for (const port of ['0', '65536', '-1', '5173foo', '0x1435', '1.5'])
      expect(() => developmentNetwork({ NH_WEB_PORT: port })).toThrow(/NH_WEB_PORT/);
    expect(() => developmentNetwork({ NH_WEB_EXTERNAL_HTTPS: 'true' })).toThrow(
      /NH_WEB_EXTERNAL_HTTPS/,
    );
    expect(() =>
      developmentNetwork({
        NH_WEB_EXTERNAL_HTTPS: '1',
        NH_PUBLIC_URL: 'https://review.example.test',
        __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: '.example.test',
      }),
    ).toThrow(/only/);
  });

  it('guards the installed Vite client contract that disables internal fallback with clientPort', async () => {
    const require = createRequire(import.meta.url);
    const viteRoot = dirname(require.resolve('vite/package.json'));
    const client = await readFile(resolve(viteRoot, 'dist/client/client.mjs'), 'utf8');
    // This intentionally guards the pinned dependency behavior, rather than implementing
    // a second WebSocket transport or relying on an undocumented boolean config option.
    expect(client).toMatch(/if \(!hmrPort\) \{\s*wsTransport =/);
    const settings = developmentNetwork({
      NH_WEB_EXTERNAL_HTTPS: '1',
      NH_PUBLIC_URL: 'https://review.example.test',
    });
    expect(typeof settings.ws === 'object' ? settings.ws.clientPort : undefined).toBe(443);
  });

  it('loads the actual config through the in-memory runner and keeps cache outside node_modules', async () => {
    vi.stubEnv('NH_WEB_CACHE_DIR', '/tmp/nickhosting-vite-test-cache');
    try {
      const loaded = await loadConfigFromFile(
        { command: 'serve', mode: 'development' },
        resolve('apps/web/vite.config.ts'),
        resolve('apps/web'),
        'silent',
        undefined,
        'runner',
      );
      expect(loaded?.config.cacheDir).toBe('/tmp/nickhosting-vite-test-cache');
      expect(loaded?.dependencies).toContain(resolve('apps/web/vite-network.ts'));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
