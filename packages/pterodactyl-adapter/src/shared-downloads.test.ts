import { describe, expect, it, vi } from 'vitest';
import {
  createPterodactylAdapter,
  type PrivateTransferCache,
  type PterodactylOptions,
} from './adapter.js';

const panel = 'https://panel.example.test';
const wings = 'https://wings.example.test';
const settings = { downloadBatchLimit: 2500, uploadBatchLimit: 500, signedUrlTtlSeconds: 900 };
function fixture() {
  const values = new Map<string, { value: string; until: number }>();
  const cache: PrivateTransferCache = {
    async get(key) {
      const current = values.get(key);
      return current && current.until > Date.now() ? current.value : undefined;
    },
    async take(key) {
      const current = values.get(key);
      values.delete(key);
      return current && current.until > Date.now() ? current.value : undefined;
    },
    async put(key, value, ttl) {
      values.set(key, { value, until: Date.now() + ttl });
    },
    async delete(key) {
      values.delete(key);
    },
  };
  let sequence = 0;
  const events: string[] = [];
  const used: string[] = [];
  const issued: string[] = [];
  function process(name: string, overrides: Partial<PterodactylOptions> = {}) {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('/transfer-settings')) {
        events.push(`${name}:settings`);
        return Response.json(settings);
      }
      if (target.pathname.endsWith('/download-urls')) {
        events.push(`${name}:issue`);
        const paths = JSON.parse(String(init?.body)).paths as string[];
        return Response.json({
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          urls: paths.map(() => {
            const token = `private-${++sequence}`;
            issued.push(token);
            return `${wings}/download/file?token=${token}`;
          }),
        });
      }
      if (target.origin === wings) {
        events.push(`${name}:download`);
        const token = target.searchParams.get('token') ?? '';
        expect(used).not.toContain(token);
        used.push(token);
        return new Response('fresh');
      }
      if (target.pathname.endsWith('/files/rename')) return new Response(null, { status: 204 });
      throw new Error('Unexpected fixture request');
    });
    const options: PterodactylOptions = {
      baseURL: panel,
      applicationKey: 'app-fixture',
      clientKey: 'owner-fixture',
      fileDownloadBinding: 'provider-revision-1',
      downloadOrigins: [wings],
      fetcher,
      transferCache: { ...cache },
      ...overrides,
    };
    return { adapter: createPterodactylAdapter(options), fetcher, options };
  }
  return { process, cache, values, events, used, issued };
}
const read = async (adapter: ReturnType<typeof createPterodactylAdapter>) =>
  Buffer.from(await adapter.readFileForEditor('server', 'server.properties')).toString();

describe('shared private download grants', () => {
  it('consumes an API-prepared grant in a separate worker without another settings or grant request first', async () => {
    const f = fixture();
    const api = f.process('api');
    const worker = f.process('worker');
    await api.adapter.prefetchDownloads('server', ['server.properties']);
    expect(await read(worker.adapter)).toBe('fresh');
    expect(f.used).toEqual(['private-1']);
    expect(f.events.indexOf('worker:download')).toBeLessThan(
      f.events.indexOf('worker:issue') < 0
        ? Number.POSITIVE_INFINITY
        : f.events.indexOf('worker:issue'),
    );
    await vi.waitFor(() => expect(f.events).toContain('worker:issue'));
    expect(f.events.filter((event) => event.endsWith(':settings'))).toEqual(['api:settings']);
  });

  it('gives concurrent process consumers distinct one-use grants', async () => {
    const f = fixture();
    await f.process('api').adapter.prefetchDownloads('server', ['server.properties']);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => read(f.process(`worker-${index}`).adapter)),
    );
    expect(results).toEqual(Array(6).fill('fresh'));
    expect(new Set(f.used).size).toBe(6);
  });

  it('never retains a local copy after an ambiguous shared publication', async () => {
    const f = fixture();
    const put = f.cache.put;
    f.cache.put = async (key, value, ttl) => {
      await put(key, value, ttl);
      if (value.includes('/download/file')) throw new Error('lost private reply');
    };
    const api = f.process('api');
    const worker = f.process('worker');
    await api.adapter.prefetchDownloads('server', ['server.properties']);
    expect(await read(worker.adapter)).toBe('fresh');
    expect(await read(api.adapter)).toBe('fresh');
    expect(f.used).toHaveLength(2);
    expect(new Set(f.used).size).toBe(2);
  });

  it('replaces an ambiguously consumed grant with a newly issued private grant', async () => {
    const f = fixture();
    await f.process('api').adapter.prefetchDownloads('server', ['server.properties']);
    const take = f.cache.take;
    f.cache.take = async (key) => {
      await take(key);
      throw new Error('lost private reply');
    };
    expect(await read(f.process('worker').adapter)).toBe('fresh');
    expect(f.used).toEqual(['private-2']);
  });

  it.each([
    { clientKey: 'rotated-owner' },
    { applicationKey: 'rotated-app' },
    { fileDownloadBinding: 'provider-revision-2' },
    { downloadOrigins: [wings, 'https://other.example.test'] },
  ])('isolates shared grants across changed provider bindings (%j)', async (change) => {
    const f = fixture();
    await f.process('api').adapter.prefetchDownloads('server', ['server.properties']);
    expect(await read(f.process('worker', change).adapter)).toBe('fresh');
    expect(f.used).toEqual(['private-2']);
  });

  it('invalidates a remote pending refill without resurrecting its previous generation', async () => {
    const f = fixture();
    const api = f.process('api');
    const worker = f.process('worker');
    await api.adapter.prefetchDownloads('server', ['server.properties']);
    const original = api.fetcher.getMockImplementation();
    const gate = Promise.withResolvers<void>();
    let waiting = false;
    api.fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/download-urls')) {
        waiting = true;
        await gate.promise;
      }
      return original?.(url, init) as Promise<Response>;
    });
    expect(await read(api.adapter)).toBe('fresh');
    await vi.waitFor(() => expect(waiting).toBe(true));
    worker.adapter.invalidateFileDownloads('server');
    await worker.adapter.prefetchDownloads('server', ['server.properties']);
    gate.resolve();
    await vi.waitFor(() => expect(f.issued).toHaveLength(3));
    expect(await read(worker.adapter)).toBe('fresh');
    expect(f.used).toEqual(['private-1', 'private-2']);
  });

  it('preserves 599 unrelated prepared grants when one path is invalidated and fences descendants only', async () => {
    const f = fixture();
    const api = f.process('api');
    const worker = f.process('worker');
    const paths = Array.from({ length: 600 }, (_, index) => `world/${index}.json`);
    await api.adapter.prefetchDownloads('server', paths);
    worker.adapter.invalidateFileDownloads('server', ['world/3.json']);
    await worker.adapter.prefetchDownloads('server', paths);
    expect(f.issued).toHaveLength(601);
    await api.adapter.prefetchDownloads('server', ['world-other/a']);
    worker.adapter.invalidateFileDownloads('server', ['world']);
    await worker.adapter.prefetchDownloads('server', [...paths, 'world-other/a']);
    expect(f.issued).toHaveLength(1202);
  });

  it('keeps cache-free mutations independent of 64 other pending shared pool scopes', async () => {
    const f = fixture();
    const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
    const pending = Array.from({ length: 64 }, (_, index) => {
      const process = f.process(`pending-${index}`, { fileDownloadBinding: `pending-${index}` });
      const original = process.fetcher.getMockImplementation();
      process.fetcher.mockImplementation(async (url, init) => {
        if (String(url).endsWith('/download-urls')) {
          const gate = Promise.withResolvers<void>();
          gates.push(gate);
          await gate.promise;
        }
        return original?.(url, init) as Promise<Response>;
      });
      return process.adapter.prefetchDownloads('server', ['server.properties']);
    });
    try {
      await vi.waitFor(() => expect(gates).toHaveLength(64));
      const mutation = f.process('unrelated-mutation', { fileDownloadBinding: 'unrelated' });
      await expect(
        mutation.adapter.renameFiles('server', '', [{ from: 'old', to: 'new' }]),
      ).resolves.toBeUndefined();
      expect(mutation.fetcher).toHaveBeenCalledTimes(1);
    } finally {
      for (const gate of gates) gate.resolve();
      await Promise.all(pending);
    }
  });

  it('ignores cache failure without retrying a consumed token or changing native error behavior', async () => {
    const f = fixture();
    const unavailable: PrivateTransferCache = {
      get: async () => {
        throw new Error('unavailable');
      },
      take: async () => {
        throw new Error('unavailable');
      },
      put: async () => {
        throw new Error('unavailable');
      },
      delete: async () => {
        throw new Error('unavailable');
      },
    };
    const worker = f.process('worker', { transferCache: unavailable });
    await worker.adapter.prefetchDownloads('server', ['server.properties']);
    expect(worker.fetcher).not.toHaveBeenCalled();
    expect(await read(worker.adapter)).toBe('fresh');
    expect(f.used).toEqual(['private-1']);
    const original = worker.fetcher.getMockImplementation();
    worker.fetcher.mockImplementation(async (url, init) =>
      String(url).endsWith('/download-urls')
        ? new Response(null, { status: 403 })
        : (original?.(url, init) as Promise<Response>),
    );
    await expect(read(worker.adapter)).rejects.toMatchObject({
      upstreamStatus: 403,
      reason: 'permission_denied',
    });
  });
});
