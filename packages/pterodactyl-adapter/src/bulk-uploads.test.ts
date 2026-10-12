import { describe, expect, it, vi } from 'vitest';
import { createPterodactylAdapter } from './adapter.js';
import { isUploadNotDispatched } from './upload-dispatch.js';

const panel = 'https://panel.example.test';
const wings = 'https://wings.example.test';
const options = {
  baseURL: panel,
  applicationKey: 'fixture-application',
  clientKey: 'fixture-managed-owner',
  uploadOrigins: [wings],
};
const fixtureAdapter = (fetcher: typeof fetch) =>
  createPterodactylAdapter({
    ...options,
    fetcher: (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/transfer-settings'))
        return Promise.resolve(
          Response.json({
            downloadBatchLimit: 2500,
            uploadBatchLimit: 500,
            signedUrlTtlSeconds: 900,
          }),
        );
      return fetcher(url, init);
    },
  });
const payload = (tokens = ['a', 'b'], expiresAt = Date.now() + 15 * 60_000) => ({
  expiresAt: new Date(expiresAt).toISOString(),
  urls: tokens.map((token) => `${wings}/upload/file?token=${token}`),
});
const body = (cancel?: () => void) => ({
  contentLength: 1,
  maxBytes: 1,
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([42]));
      controller.close();
    },
    cancel,
  }),
});

describe('Blueprint bulk upload credentials', () => {
  it('requests 49 distinct credentials once with the managed Client key and streams exact private handoffs', async () => {
    let issuance = 0;
    const used = new Set<string>();
    const destinations: string[] = [];
    const paths = Array.from({ length: 49 }, (_, index) => `world/file-${index}.bin`);
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const target = new URL(String(url));
      if (target.origin === panel) {
        issuance++;
        expect(target.pathname).toBe(
          '/api/client/extensions/nickhosting/servers/fixture/upload-urls',
        );
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ count: 49 });
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer fixture-managed-owner',
        );
        return Response.json(payload(paths.map((_, index) => `private-${index}`)));
      }
      expect(target.origin).toBe(wings);
      expect(target.searchParams.get('directory')).toBe('/world');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      const token = target.searchParams.get('token');
      if (!token) throw new Error('Missing fixture token');
      expect(used.has(token)).toBe(false);
      used.add(token);
      const text = await new Response(init?.body).text();
      const filename = /filename="([^"]+)"/.exec(text)?.[1];
      destinations.push(`world/${filename}`);
      return new Response(null, { status: 204 });
    });
    const adapter = fixtureAdapter(fetcher);
    const batch = await adapter.prepareUploadBatch('fixture', paths);
    expect(issuance).toBe(1);
    expect(used.size).toBe(0);
    if (!batch) throw new Error('Missing batch');
    expect(batch.uploads).toHaveLength(49);
    expect(JSON.stringify(batch)).not.toContain('private-');
    expect(JSON.stringify(batch)).not.toContain(wings);
    await Promise.all(batch.uploads.map((send) => send(body())));
    expect(issuance).toBe(1);
    expect(used.size).toBe(49);
    expect(destinations).toEqual(paths);
    const send = batch.uploads[0];
    if (!send) throw new Error('Missing handoff');
    await expect(send(body())).rejects.toSatisfy(isUploadNotDispatched);
    expect(fetcher).toHaveBeenCalledTimes(50);
  });

  it('returns null only when the older extension has no bulk endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    expect(await fixtureAdapter(fetcher).prepareUploadBatch('fixture', ['a'])).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 409, 429, 500])(
    'preserves HTTP %s failures without a single-token fallback',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response('private upstream body', { status }),
      );
      const promise = fixtureAdapter(fetcher).prepareUploadBatch('fixture', ['a']);
      await expect(promise).rejects.toMatchObject({ upstreamStatus: status });
      await expect(promise).rejects.toSatisfy(isUploadNotDispatched);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { paths: [] },
    { paths: ['same', 'same'] },
    { paths: ['../unsafe'] },
    { paths: ['/absolute'] },
    { paths: ['bad%2fpath'] },
    { paths: Array.from({ length: 501 }, (_, index) => String(index)) },
  ])('rejects an invalid manifest before credential issuance (%#)', async ({ paths }) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      fixtureAdapter(fetcher).prepareUploadBatch('fixture', paths),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    () => payload(['a']),
    () => payload(['a', 'a']),
    () => ({
      ...payload(),
      urls: [`${wings}/upload/file?token=a`, `${wings}/upload/file?directory=/elsewhere&token=a`],
    }),
    () => ({
      ...payload(),
      urls: [`${wings}/upload/file?token=a`, `${wings}/upload/file?token=b&token=c`],
    }),
    () => ({ ...payload(), urls: [`${wings}/upload/file?token=a`, `${wings}/upload/file`] }),
    () => payload(['a', 'b'], Date.now() - 1),
    () => payload(['a', 'b'], Date.now() + 17 * 60_000),
    () => ({ ...payload(), expiresAt: 'tomorrow' }),
    () => ({ ...payload(), unexpected: 'private value' }),
    () => ({ ...payload(), urls: [`${wings}/upload/file?token=a`, `${wings}/delete?token=b`] }),
    () => ({
      ...payload(),
      urls: [`${wings}/upload/file?token=a`, `https://untrusted.example.test/upload/file?token=b`],
    }),
  ])('rejects the complete malformed response before any Wings POST (%#)', async (response) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()));
    await expect(
      fixtureAdapter(fetcher).prepareUploadBatch('fixture', ['a', 'b']),
    ).rejects.toSatisfy(isUploadNotDispatched);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects expired unused credentials without dispatching or replaying an upload', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload(['a'], now + 60_000)));
    try {
      const batch = await fixtureAdapter(fetcher).prepareUploadBatch('fixture', ['a']);
      const send = batch?.uploads[0];
      if (!send) throw new Error('Missing handoff');
      clock.mockReturnValue(now + 60_001);
      const cancelled = vi.fn();
      await expect(send(body(cancelled))).rejects.toSatisfy(isUploadNotDispatched);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('preserves abort and current authorization checks before issuance and transfer', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload(['a'])));
    const adapter = fixtureAdapter(fetcher);
    await expect(
      adapter.prepareUploadBatch('fixture', ['a'], { signal: AbortSignal.abort() }),
    ).rejects.toSatisfy(isUploadNotDispatched);
    await expect(
      adapter.prepareUploadBatch('fixture', ['a'], {
        authorize: async () => {
          throw new Error('revoked');
        },
      }),
    ).rejects.toSatisfy(isUploadNotDispatched);
    expect(fetcher).not.toHaveBeenCalled();
    const batch = await adapter.prepareUploadBatch('fixture', ['a']);
    const send = batch?.uploads[0];
    if (!send) throw new Error('Missing handoff');
    await expect(
      send({
        ...body(),
        authorize: async () => {
          throw new Error('revoked');
        },
      }),
    ).rejects.toSatisfy(isUploadNotDispatched);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('configurable Blueprint upload batches', () => {
  it('splits an existing manifest by the configured limit and preserves ordered private handoffs', async () => {
    const counts: number[] = [];
    const settings = { downloadBatchLimit: 2500, uploadBatchLimit: 2, signedUrlTtlSeconds: 60 };
    let sequence = 0;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/transfer-settings'))
        return Response.json(settings);
      const { count } = JSON.parse(String(init?.body)) as { count: number };
      counts.push(count);
      return Response.json(
        payload(
          Array.from({ length: count }, () => `unique-${++sequence}`),
          Date.now() + settings.signedUrlTtlSeconds * 1000,
        ),
      );
    });
    const adapter = createPterodactylAdapter({ ...options, fetcher });
    const batch = await adapter.prepareUploadBatch('fixture', ['a', 'b', 'c', 'd', 'e']);
    expect(batch?.uploads).toHaveLength(5);
    expect(counts).toEqual([2, 2, 1]);
    settings.signedUrlTtlSeconds = 900;
    await expect(adapter.prepareUploadBatch('fixture', ['f'])).resolves.toMatchObject({
      uploads: [expect.any(Function)],
    });
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith('/transfer-settings')),
    ).toHaveLength(1);
  });

  it('refreshes the settings once if the configured upload limit was lowered', async () => {
    let limit = 2;
    let sequence = 0;
    const counts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/transfer-settings'))
        return Response.json({
          downloadBatchLimit: 2500,
          uploadBatchLimit: limit,
          signedUrlTtlSeconds: 900,
        });
      const { count } = JSON.parse(String(init?.body)) as { count: number };
      counts.push(count);
      if (count > limit) return new Response(null, { status: 422 });
      return Response.json(payload(Array.from({ length: count }, () => `unique-${++sequence}`)));
    });
    const adapter = createPterodactylAdapter({ ...options, fetcher });
    await adapter.prepareUploadBatch('fixture', ['a', 'b']);
    limit = 1;
    expect((await adapter.prepareUploadBatch('fixture', ['c', 'd']))?.uploads).toHaveLength(2);
    expect(counts).toEqual([2, 2, 1, 1]);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith('/transfer-settings')),
    ).toHaveLength(2);
  });

  it.each([403, 429])('does not bypass denied transfer settings (%s)', async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status }));
    await expect(
      createPterodactylAdapter({ ...options, fetcher }).prepareUploadBatch('fixture', ['a']),
    ).rejects.toMatchObject({ upstreamStatus: status });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
