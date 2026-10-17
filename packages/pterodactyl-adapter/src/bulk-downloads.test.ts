import { describe, expect, it, vi } from 'vitest';
import { createPterodactylAdapter, type PterodactylOptions } from './adapter.js';

const panel = 'https://panel.example.test';
const wings = 'https://wings.example.test';
const defaults = { downloadBatchLimit: 2500, uploadBatchLimit: 500, signedUrlTtlSeconds: 900 };
function fixture(overrides: Partial<PterodactylOptions> = {}) {
  let sequence = 0;
  const batches: string[][] = [];
  const used: string[] = [];
  const settings = { ...defaults };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith('/transfer-settings')) return Response.json(settings);
    if (target.pathname.endsWith('/download-urls')) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-client');
      const paths = (JSON.parse(String(init?.body)) as { paths: string[] }).paths;
      batches.push(paths);
      return Response.json({
        expiresAt: new Date(Date.now() + settings.signedUrlTtlSeconds * 1000).toISOString(),
        urls: paths.map(() => `${wings}/download/file?token=private-${++sequence}`),
      });
    }
    if (target.origin === wings) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.redirect).toBe('error');
      const token = target.searchParams.get('token');
      if (!token) throw new Error('missing token');
      expect(used).not.toContain(token);
      used.push(token);
      return new Response('fixture', { headers: { 'content-length': '7' } });
    }
    if (/\/(rename|delete|restore|reinstall)$/.test(target.pathname))
      return new Response(null, { status: 204 });
    throw new Error('unexpected request');
  });
  const options: PterodactylOptions = {
    baseURL: panel,
    applicationKey: 'fixture-app',
    clientKey: 'fixture-client',
    fileDownloadBinding: 'managed-server-revision-1',
    downloadOrigins: [wings],
    fetcher,
    ...overrides,
  };
  return { adapter: createPterodactylAdapter(options), options, fetcher, batches, used, settings };
}
const text = async (
  download: Awaited<ReturnType<ReturnType<typeof createPterodactylAdapter>['downloadFile']>>,
) => new Response(download.body).text();

describe('private Blueprint signed download pool', () => {
  it('prefetches 600 files once, reuses across adapter instances and replenishes only the consumed path', async () => {
    const f = fixture();
    const paths = Array.from({ length: 600 }, (_, i) => `world/${i}.json`);
    await f.adapter.prefetchDownloads('fixture', paths);
    expect(f.batches).toEqual([paths]);
    expect(f.used).toEqual([]);
    await createPterodactylAdapter(f.options).prefetchDownloads('fixture', paths);
    expect(f.batches).toHaveLength(1);
    const next = createPterodactylAdapter(f.options);
    expect(Buffer.from(await next.readFileForEditor('fixture', 'world/3.json')).toString()).toBe(
      'fixture',
    );
    await vi.waitFor(() => expect(f.batches).toHaveLength(2));
    expect(f.batches[1]).toEqual(['world/3.json']);
    await next.prefetchDownloads('fixture', paths);
    expect(f.batches).toHaveLength(2);
    expect(await text(await next.downloadFile('fixture', 'world/4.json', {}))).toBe('fixture');
    await vi.waitFor(() => expect(f.batches[2]).toEqual(['world/4.json']));
  });

  it('shares pending prefetch and reserves a distinct one-use token for concurrent consumers', async () => {
    const f = fixture();
    await Promise.all([
      f.adapter.prefetchDownloads('fixture', ['a']),
      f.adapter.prefetchDownloads('fixture', ['a']),
    ]);
    expect(f.batches).toEqual([['a']]);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        createPterodactylAdapter(f.options).downloadFile('fixture', 'a', {}),
      ),
    );
    expect(await Promise.all(results.map(text))).toEqual([
      'fixture',
      'fixture',
      'fixture',
      'fixture',
    ]);
    expect(new Set(f.used).size).toBe(4);
    await vi.waitFor(() => expect(f.batches).toHaveLength(5));
  });

  it('expires quietly with no perpetual renewal and reissues only when needed', async () => {
    const f = fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await f.adapter.prefetchDownloads('fixture', ['a', 'b']);
      clock.mockReturnValue(now + 871_000);
      expect(f.batches).toHaveLength(1);
      await f.adapter.prefetchDownloads('fixture', ['a']);
      expect(f.batches).toEqual([['a', 'b'], ['a']]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    { clientKey: 'changed-client' },
    { applicationKey: 'changed-app' },
    { fileDownloadBinding: 'changed-revision' },
    { downloadOrigins: [wings, 'https://another.example.test'] },
  ])('isolates cached credentials when binding changes: %j', async (change) => {
    const f = fixture();
    await f.adapter.prefetchDownloads('fixture', ['a']);
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/download-urls'))
        return Response.json({
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          urls: [`${wings}/download/file?token=changed`],
        });
      return f.fetcher(url, init);
    });
    // Retain fetcher identity for credential isolation; temporarily bypass fixture auth expectation.
    f.fetcher.mockImplementation(async (url) =>
      new URL(String(url)).pathname.endsWith('/transfer-settings')
        ? Response.json(defaults)
        : Response.json({
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            urls: [`${wings}/download/file?token=changed`],
          }),
    );
    const before = f.fetcher.mock.calls.length;
    await createPterodactylAdapter({ ...f.options, ...change }).prefetchDownloads('fixture', ['a']);
    expect(f.fetcher.mock.calls.length).toBe(before + 2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps test fetchers isolated despite identical URLs and keys', async () => {
    const a = fixture();
    const b = fixture();
    await a.adapter.prefetchDownloads('fixture', ['a']);
    await b.adapter.prefetchDownloads('fixture', ['a']);
    expect(a.batches).toHaveLength(1);
    expect(b.batches).toHaveLength(1);
  });

  it('invalidates source and destination descendants across rename/delete and server restore', async () => {
    const f = fixture();
    const paths = ['old/a', 'new/a', 'other/a'];
    await f.adapter.prefetchDownloads('fixture', paths);
    await f.adapter.renameFiles('fixture', '', [{ from: 'old', to: 'new' }]);
    await f.adapter.prefetchDownloads('fixture', paths);
    expect(f.batches[1]).toEqual(['old/a', 'new/a']);
    await f.adapter.deleteFiles('fixture', '', ['new']);
    await f.adapter.prefetchDownloads('fixture', paths);
    expect(f.batches[2]).toEqual(['new/a']);
    await f.adapter.restoreBackup('fixture', 'd88b2668-c030-4e16-a4e3-25872640dd28', true);
    await f.adapter.prefetchDownloads('fixture', paths);
    expect(f.batches[3]).toEqual(paths);
  });

  it('does not install a pending token after its path is invalidated', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    const original = f.fetcher.getMockImplementation();
    f.fetcher.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/download-urls'))
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return original?.(url, init) as Promise<Response>;
    });
    const pending = f.adapter.prefetchDownloads('fixture', ['a']);
    await vi.waitFor(() => expect(release).toBeDefined());
    f.adapter.invalidateFileDownloads('fixture', ['a']);
    release?.();
    await pending;
    if (!original) throw new Error('missing fixture');
    f.fetcher.mockImplementation(original);
    await f.adapter.prefetchDownloads('fixture', ['a']);
    expect(f.batches).toEqual([['a'], ['a']]);
  });

  it('honors configured batch limits, refreshes a lowered limit once, and accepts a raised TTL', async () => {
    const f = fixture();
    f.settings.downloadBatchLimit = 2;
    f.settings.signedUrlTtlSeconds = 60;
    await f.adapter.prefetchDownloads('fixture', ['a', 'b', 'c']);
    expect(f.batches).toEqual([['a', 'b'], ['c']]);
    f.settings.downloadBatchLimit = 1;
    f.settings.signedUrlTtlSeconds = 900;
    const original = f.fetcher.getMockImplementation();
    f.fetcher.mockImplementation(async (url, init) => {
      if (
        new URL(String(url)).pathname.endsWith('/download-urls') &&
        JSON.parse(String(init?.body)).paths.length > 1
      )
        return new Response(null, { status: 422 });
      return original?.(url, init) as Promise<Response>;
    });
    await f.adapter.prefetchDownloads('fixture', ['d', 'e']);
    expect(f.batches.slice(2)).toEqual([['d'], ['e']]);
    // Raise only TTL while the cached limit is still fresh: native valid TTL must be accepted.
    f.settings.signedUrlTtlSeconds = 60;
    await f.adapter.prefetchDownloads('other', ['a']);
    f.settings.signedUrlTtlSeconds = 900;
    await f.adapter.prefetchDownloads('other', ['b']);
  });

  it('chunks actual long-token responses within the JSON budget without extra directory reads', async () => {
    const f = fixture();
    const paths = Array.from({ length: 600 }, (_, i) => `${'x'.repeat(4000)}/${i}`);
    let sequence = 0;
    const original = f.fetcher.getMockImplementation();
    f.fetcher.mockImplementation(async (url, init) => {
      const response = await original?.(url, init);
      if (new URL(String(url)).pathname.endsWith('/download-urls')) {
        const chunk = (JSON.parse(String(init?.body)) as { paths: string[] }).paths;
        const value = {
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          urls: chunk.map(
            (path) =>
              `${wings}/download/file?token=${Buffer.from(JSON.stringify({ file_path: path, unique_id: ++sequence })).toString('base64url')}`,
          ),
        };
        expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(4 * 1024 * 1024);
        return Response.json(value);
      }
      if (!response) throw new Error('missing fixture response');
      return response;
    });
    await f.adapter.prefetchDownloads('fixture', paths);
    expect(f.batches.length).toBeGreaterThan(1);
    expect(f.batches.flat()).toEqual(paths);
    expect(f.fetcher.mock.calls.every(([url]) => !String(url).includes('/files/list'))).toBe(true);
  });

  it('does not strand earlier reservations when a later path has a cached issuance error', async () => {
    const f = fixture();
    const original = f.fetcher.getMockImplementation();
    f.fetcher.mockImplementation(async (url, init) => {
      if (
        new URL(String(url)).pathname.endsWith('/download-urls') &&
        JSON.parse(String(init?.body)).paths.includes('a')
      )
        return new Response(null, { status: 403 });
      return original?.(url, init) as Promise<Response>;
    });
    await expect(f.adapter.prefetchDownloads('fixture', ['a'])).rejects.toMatchObject({
      reason: 'permission_denied',
    });
    await expect(f.adapter.prefetchDownloads('fixture', ['b', 'a'])).rejects.toMatchObject({
      reason: 'permission_denied',
    });
    await f.adapter.prefetchDownloads('fixture', ['b']);
    expect(f.batches).toEqual([['b']]);
    expect(Buffer.from(await f.adapter.readFileForEditor('fixture', 'b')).toString()).toBe(
      'fixture',
    );
  });

  it.each([403, 429, 500])(
    'never downgrades a failed background issuance (%s) to native signing',
    async (status) => {
      const f = fixture();
      f.fetcher.mockImplementation(async (url) =>
        new URL(String(url)).pathname.endsWith('/transfer-settings')
          ? Response.json(defaults)
          : new Response(null, { status }),
      );
      await expect(f.adapter.prefetchDownloads('fixture', ['a'])).rejects.toMatchObject({
        upstreamStatus: status,
      });
      await expect(f.adapter.readFileForEditor('fixture', 'a')).rejects.toMatchObject({
        upstreamStatus: status,
      });
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it('uses native one-use issuance only for a missing endpoint and does not coalesce concurrent GETs', async () => {
    const f = fixture();
    let native = 0;
    const original = f.fetcher.getMockImplementation();
    f.fetcher.mockImplementation(async (url, init) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('/download-urls')) return new Response(null, { status: 404 });
      if (target.pathname.endsWith('/files/download'))
        return Response.json({
          attributes: { url: `${wings}/download/file?token=native-${++native}` },
        });
      return original?.(url, init) as Promise<Response>;
    });
    await f.adapter.prefetchDownloads('fixture', ['a']);
    const results = await Promise.all([
      f.adapter.downloadFile('fixture', 'a', {}),
      f.adapter.downloadFile('fixture', 'a', {}),
    ]);
    await Promise.all(results.map(text));
    expect(native).toBe(2);
    expect(
      f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/download-urls')),
    ).toHaveLength(1);
  });

  it.each(['duplicate', 'untrusted', 'wrong-path', 'missing-token', 'expired', 'far-future'])(
    'rejects malformed signed batches: %s',
    async (kind) => {
      const f = fixture();
      f.fetcher.mockImplementation(async (url) => {
        if (new URL(String(url)).pathname.endsWith('/transfer-settings'))
          return Response.json(defaults);
        let urls = [`${wings}/download/file?token=a`, `${wings}/download/file?token=b`];
        if (kind === 'duplicate') urls = [urls[0] as string, urls[0] as string];
        if (kind === 'untrusted') urls[1] = 'https://foreign.example.test/download/file?token=b';
        if (kind === 'wrong-path') urls[1] = `${wings}/delete?token=b`;
        if (kind === 'missing-token') urls[1] = `${wings}/download/file`;
        return Response.json({
          urls,
          expiresAt: new Date(
            Date.now() + (kind === 'expired' ? -1 : kind === 'far-future' ? 1_000_000 : 900_000),
          ).toISOString(),
        });
      });
      await expect(f.adapter.prefetchDownloads('fixture', ['a', 'b'])).rejects.toBeDefined();
      await expect(f.adapter.downloadFile('fixture', 'a', {})).rejects.toBeDefined();
      expect(f.used).toEqual([]);
    },
  );

  it.each([false, true])(
    'bounds editor bytes and cancels the Wings stream with declared length=%s',
    async (declared) => {
      const f = fixture();
      await f.adapter.prefetchDownloads('fixture', ['a']);
      const cancelled = vi.fn();
      const original = f.fetcher.getMockImplementation();
      f.fetcher.mockImplementation(async (url, init) => {
        if (new URL(String(url)).origin === wings)
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(10));
              },
              cancel: cancelled,
            }),
            { headers: declared ? { 'content-length': '10' } : {} },
          );
        return original?.(url, init) as Promise<Response>;
      });
      await expect(f.adapter.readFileForEditor('fixture', 'a', 4)).rejects.toMatchObject({
        code: 'validation_failed',
        status: 413,
      });
      expect(cancelled).toHaveBeenCalledOnce();
    },
  );

  it.each([404, 200])(
    'rejects missing or truncated editor downloads (status %s)',
    async (status) => {
      const f = fixture();
      await f.adapter.prefetchDownloads('fixture', ['a']);
      const original = f.fetcher.getMockImplementation();
      f.fetcher.mockImplementation(async (url, init) =>
        new URL(String(url)).origin === wings
          ? new Response('short', { status, headers: { 'content-length': '50' } })
          : (original?.(url, init) as Promise<Response>),
      );
      await expect(f.adapter.readFileForEditor('fixture', 'a')).rejects.toMatchObject({
        reason: status === 404 ? 'not_found' : 'invalid_response',
      });
    },
  );

  it('does not make cache-free mutations depend on capacity in other pending scopes', async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const releases: Array<() => void> = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('/transfer-settings')) return Response.json(defaults);
      if (target.pathname.endsWith('/download-urls')) {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return Response.json({
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          urls: [`${wings}/download/file?token=a`],
        });
      }
      if (target.pathname.endsWith('/files/rename')) return new Response(null, { status: 204 });
      throw new Error('unexpected request');
    });
    const config = {
      baseURL: panel,
      applicationKey: 'fixture-app',
      clientKey: 'fixture-client',
      downloadOrigins: [wings],
      fetcher,
    };
    const pending = Array.from({ length: 64 }, (_, i) =>
      createPterodactylAdapter({
        ...config,
        fileDownloadBinding: `capacity-${i}`,
      }).prefetchDownloads('fixture', ['a']),
    );
    try {
      await vi.waitFor(() => expect(releases).toHaveLength(64));
      await expect(
        createPterodactylAdapter({
          ...config,
          fileDownloadBinding: 'unrelated-mutation',
        }).renameFiles('fixture', '', [{ from: 'a', to: 'b' }]),
      ).resolves.toBeUndefined();
    } finally {
      for (const release of releases) release();
      await Promise.all(pending);
    }
  });

  it('keeps guarded mutation reads on the contents endpoint and cancels streamed downloads', async () => {
    const f = fixture();
    const original = f.fetcher.getMockImplementation();
    const cancelled = vi.fn();
    f.fetcher.mockImplementation(async (url, init) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('/files/contents')) return new Response('mutation-proof');
      if (target.origin === wings)
        return new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array([1]));
            },
            cancel: cancelled,
          }),
        );
      return original?.(url, init) as Promise<Response>;
    });
    expect(Buffer.from(await f.adapter.readFile('fixture', 'a')).toString()).toBe('mutation-proof');
    expect(f.batches).toEqual([]);
    const download = await f.adapter.downloadFile('fixture', 'a', {});
    await download.body.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
