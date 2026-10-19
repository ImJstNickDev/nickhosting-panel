import { describe, expect, it, vi } from 'vitest';
import { createPterodactylAdapter } from './adapter.js';
import { isUploadCancelled, isUploadNotPublished } from './upload-dispatch.js';

const origin = 'https://fixture.example.test';
const original = 'previous contents';
const identity = {
  providerId: 7,
  providerUuid: '11111111-1111-4111-8111-111111111111',
  identifier: 'server',
  externalId: 'nh-test',
  nodeId: 2,
};

/** Reproduces the important Wings 1.13 WriteFrom behavior: O_TRUNC at
 * multipart-part arrival, bytes written before request completion, remove on
 * read failure. Native rename refuses an existing destination on both versions. */
function fixture() {
  const files = new Map<string, string>([['/config/server.properties', original]]);
  const uploads: string[] = [];
  const publications: Array<{ from: string; to: string }> = [];
  const removed: string[] = [];
  const chmods: Array<{ file: string; mode: string }> = [];
  const hooks: {
    firstChunk?: () => void;
    uploadStatus?: number;
    lostUploadResponse?: boolean;
    publish?: 'lost-response' | 'reject' | 'uncertain' | 'wrong-receipt';
    cleanupFailure?: boolean;
    mode?: string;
  } = {};
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith('/files/list'))
      return Response.json({
        object: 'list',
        data: [
          {
            attributes: {
              name: 'server.properties',
              size: original.length,
              mode: '-rw-r--r--',
              mode_bits: hooks.mode ?? '644',
              is_file: true,
              is_symlink: false,
              mimetype: 'text/plain',
              created_at: '',
              modified_at: '',
            },
          },
        ],
      });
    if (target.pathname.endsWith('/files/upload'))
      return Response.json({ attributes: { url: `${origin}/upload/file?token=private` } });
    if (target.pathname === '/upload/file') {
      if (hooks.uploadStatus) return new Response(null, { status: hooks.uploadStatus });
      if (!(init?.body instanceof ReadableStream)) throw new Error('Missing test body');
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read();
      const prefix = Buffer.from(first.value ?? []).toString();
      const filename = /filename="([^"]+)"/.exec(prefix)?.[1];
      const boundary = /boundary=(.+)/.exec(
        new Headers(init?.headers).get('content-type') ?? '',
      )?.[1];
      if (!filename || !boundary) throw new Error('Invalid test multipart');
      const path = `${target.searchParams.get('directory')}/${filename}`.replaceAll('//', '/');
      uploads.push(path);
      files.set(path, '');
      let body = '';
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          body += Buffer.from(item.value).toString();
          files.set(path, body);
          hooks.firstChunk?.();
        }
      } catch {
        files.delete(path);
        return new Response(null, { status: 500 });
      } finally {
        reader.releaseLock();
      }
      const suffix = `\r\n--${boundary}--\r\n`;
      if (!body.endsWith(suffix)) {
        files.delete(path);
        return new Response(null, { status: 500 });
      }
      files.set(path, body.slice(0, -suffix.length));
      if (hooks.lostUploadResponse) throw new Error('Upload reply lost');
      return new Response(null, { status: 204 });
    }
    if (target.pathname.endsWith('/files/write')) {
      files.set(target.searchParams.get('file') as string, String(init?.body));
      return new Response(null, { status: 204 });
    }
    const input = JSON.parse(String(init?.body));
    if (target.pathname.endsWith('/files/chmod')) {
      chmods.push(...input.files);
      return new Response(null, { status: 204 });
    }
    if (target.pathname.endsWith('/upload-publication')) {
      expect(input.identity).toEqual(identity);
      expect(input.source).toBe(`config/.nh-upload-${input.operationId}.pending`);
      publications.push({ from: input.source, to: input.destination });
      if (hooks.publish === 'reject') return new Response(null, { status: 403 });
      const source = `/${input.source}`;
      const destination = `/${input.destination}`;
      const backup = source.replace(/\.pending$/, '.previous');
      files.set(backup, files.get(destination) as string);
      files.delete(destination);
      if (hooks.publish !== 'uncertain') {
        files.set(destination, files.get(source) as string);
        files.delete(source);
        files.delete(backup);
      }
      if (hooks.publish === 'lost-response') throw new Error('Lost provider reply');
      return Response.json({
        operationId: input.operationId,
        identity: hooks.publish === 'wrong-receipt' ? { ...identity, providerId: 8 } : identity,
        destination: input.destination,
        state: hooks.publish === 'uncertain' ? 'uncertain' : 'confirmed',
      });
    }
    if (target.pathname.endsWith('/files/rename')) {
      const move = input.files[0] as { from: string; to: string };
      publications.push(move);
      const from = `/${move.from}`;
      const to = `/${move.to}`;
      // Faithful upstream behavior: Rename refuses overwrites. It also silently
      // tolerates a missing source at the HTTP layer.
      if (files.has(to)) return new Response(null, { status: 409 });
      const content = files.get(from);
      if (content !== undefined) {
        files.set(to, content);
        files.delete(from);
      }
      return new Response(null, { status: 204 });
    }
    if (target.pathname.endsWith('/files/delete')) {
      if (hooks.cleanupFailure) return new Response(null, { status: 500 });
      for (const file of input.files as string[]) {
        const path = `/${file}`;
        removed.push(path);
        files.delete(path);
      }
      return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected test request');
  });
  const adapter = createPterodactylAdapter({
    baseURL: origin,
    applicationKey: 'application-fixture',
    clientKey: 'client-fixture',
    managedProviderIdentity: identity,
    uploadOrigins: [origin],
    fetcher,
  });
  return { adapter, files, hooks, uploads, publications, removed, chmods, fetcher };
}

function body(value: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(value));
      controller.close();
    },
  });
}

describe('streamed upload publication', () => {
  it('publishes a replacement only after all bytes arrive, using a unique sibling and a durable replacement receipt', async () => {
    const f = fixture();
    f.hooks.firstChunk = () => expect(f.files.get('/config/server.properties')).toBe(original);
    await f.adapter.uploadFile('server', 'config/server.properties', {
      body: body('new contents'),
      contentLength: 12,
      maxBytes: 12,
    });
    expect(f.files).toEqual(new Map([['/config/server.properties', 'new contents']]));
    expect(f.publications).toHaveLength(1);
    expect(f.publications[0]?.from).toMatch(/^config\/\.nh-upload-[a-f0-9-]{36}\.pending$/);
    expect(f.publications[0]?.to).toBe('config/server.properties');
    expect(f.removed).toEqual([]);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(['config/server.properties', 'config/new.txt'])(
    'cancellation never truncates the destination %s',
    async (path) => {
      const f = fixture();
      const signal = new AbortController();
      f.hooks.firstChunk = () => signal.abort();
      const error = await f.adapter
        .uploadFile('server', path, {
          body: body('new contents'),
          contentLength: 12,
          maxBytes: 12,
          signal: signal.signal,
        })
        .catch((error: unknown) => error);
      expect(isUploadCancelled(error)).toBe(true);
      expect(isUploadNotPublished(error)).toBe(true);
      expect(f.files).toEqual(new Map([['/config/server.properties', original]]));
      expect(f.publications).toEqual([]);
      expect(f.removed).toEqual(f.uploads);
    },
  );

  it('keeps an uncertain publication unchanged and never retries or cleans its source', async () => {
    const f = fixture();
    f.hooks.publish = 'lost-response';
    const error = await f.adapter
      .uploadFile('server', 'config/server.properties', {
        body: body('new contents'),
        contentLength: 12,
        maxBytes: 12,
      })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ outcome: 'unknown' });
    expect(isUploadNotPublished(error)).toBe(false);
    expect(f.files.get('/config/server.properties')).toBe('new contents');
    expect(f.publications).toHaveLength(1);
    expect(f.removed).toEqual([]);
  });

  it('uses native rename for a new path without a replacement receipt', async () => {
    const f = fixture();
    await f.adapter.uploadFile('server', 'config/new.txt', {
      body: body('new contents'),
      contentLength: 12,
      maxBytes: 12,
    });
    expect(f.files.get('/config/server.properties')).toBe(original);
    expect(f.files.get('/config/new.txt')).toBe('new contents');
    expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith('/upload-publication'))).toBe(
      false,
    );
  });

  it('preserves backup and stage after an uncertain replacement without replay', async () => {
    const f = fixture();
    f.hooks.publish = 'uncertain';
    const error = await f.adapter
      .uploadFile('server', 'config/server.properties', {
        body: body('new contents'),
        contentLength: 12,
        maxBytes: 12,
      })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ outcome: 'unknown' });
    expect(isUploadNotPublished(error)).toBe(false);
    expect([...f.files.entries()]).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/\.previous$/), original],
        [expect.stringMatching(/\.pending$/), 'new contents'],
      ]),
    );
    expect(f.publications).toHaveLength(1);
    expect(f.removed).toEqual([]);
  });

  it('rejects a receipt for a different identity without retrying', async () => {
    const f = fixture();
    f.hooks.publish = 'wrong-receipt';
    await expect(
      f.adapter.uploadFile('server', 'config/server.properties', {
        body: body('new contents'),
        contentLength: 12,
        maxBytes: 12,
      }),
    ).rejects.toMatchObject({ outcome: 'unknown', reason: 'invalid_response' });
    expect(f.publications).toHaveLength(1);
    expect(f.removed).toEqual([]);
  });

  it('keeps a lost upstream upload response uncertain without racing its writer with cleanup', async () => {
    const f = fixture();
    f.hooks.lostUploadResponse = true;
    const error = await f.adapter
      .uploadFile('server', 'config/server.properties', {
        body: body('new contents'),
        contentLength: 12,
        maxBytes: 12,
      })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ outcome: 'unknown' });
    expect(isUploadNotPublished(error)).toBe(false);
    expect(f.files.get('/config/server.properties')).toBe(original);
    expect(f.publications).toEqual([]);
    expect(f.removed).toEqual([]);
    expect([...f.files.keys()].filter((path) => path.endsWith('.pending'))).toHaveLength(1);
  });

  it.each([500, 502, 503, 504])(
    'does not race cleanup against a writer after a proxy HTTP %i',
    async (status) => {
      const f = fixture();
      f.hooks.uploadStatus = status;
      const error = await f.adapter
        .uploadFile('server', 'config/server.properties', {
          body: body('new contents'),
          contentLength: 12,
          maxBytes: 12,
        })
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ outcome: 'unknown', upstreamStatus: status });
      expect(isUploadNotPublished(error)).toBe(false);
      expect(f.publications).toEqual([]);
      expect(f.removed).toEqual([]);
      expect(f.files.get('/config/server.properties')).toBe(original);
    },
  );

  it('does not describe failed temporary cleanup as confirmed cancellation', async () => {
    const f = fixture();
    const signal = new AbortController();
    f.hooks.firstChunk = () => signal.abort();
    f.hooks.cleanupFailure = true;
    const error = await f.adapter
      .uploadFile('server', 'config/server.properties', {
        body: body('new contents'),
        contentLength: 12,
        maxBytes: 12,
        signal: signal.signal,
      })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ outcome: 'unknown' });
    expect(isUploadCancelled(error)).toBe(false);
    expect(f.files.get('/config/server.properties')).toBe(original);
  });

  it('does not replay a streaming body after Wings invalidates a prepared token', async () => {
    const f = fixture();
    f.hooks.uploadStatus = 404;
    const error = await f.adapter
      .uploadFile('server', 'config/server.properties', {
        body: body('new contents'),
        contentLength: 12,
        maxBytes: 12,
      })
      .catch((error: unknown) => error);
    expect(isUploadNotPublished(error)).toBe(true);
    expect(error).toMatchObject({ upstreamStatus: 404 });
    expect(f.files.get('/config/server.properties')).toBe(original);
    expect(f.publications).toEqual([]);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });
  it.each(['600', '755'])(
    'preserves an existing destination mode %s before publishing',
    async (mode) => {
      const f = fixture();
      f.hooks.mode = mode;
      await f.adapter.uploadFile('server', 'config/server.properties', {
        body: body('new contents'),
        contentLength: 12,
        maxBytes: 12,
      });
      expect(f.chmods).toEqual([{ file: f.publications[0]?.from, mode }]);
      const calls = f.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);
      if (mode === '600')
        expect(calls.indexOf('/api/client/servers/server/files/chmod')).toBeLessThan(
          calls.indexOf('/upload/file'),
        );
      else
        expect(calls.slice(-2)).toEqual([
          '/api/client/servers/server/files/chmod',
          '/api/client/extensions/nickhosting/servers/server/upload-publication',
        ]);
    },
  );
});
