import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPterodactylAdapter,
  type FileReadTiming,
  type PrivateTransferCache,
  type PterodactylOptions,
} from './adapter.js';
import { isUploadNotDispatched } from './upload-dispatch.js';

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
  const uploads: Array<{ url: URL; body: string; headers: Headers }> = [];
  const writes: Array<{ path: string | null; body: string }> = [];
  const hooks: {
    issue?: () => Promise<Response>;
    upload?: () => Promise<Response>;
    panelWrite?: () => Promise<Response>;
  } = {};
  function process(name: string, overrides: Partial<PterodactylOptions> = {}) {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('/transfer-settings')) {
        events.push(`${name}:settings`);
        return Response.json(settings);
      }
      if (target.pathname.endsWith('/upload-urls')) {
        events.push(`${name}:issue`);
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ count: 1 });
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Bearer ${overrides.clientKey ?? 'private-client'}`,
        );
        return hooks.issue
          ? hooks.issue()
          : Response.json({
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              urls: [`${wings}/upload/file?directory=/unwanted&token=private-${++sequence}`],
            });
      }
      if (target.origin === wings) {
        events.push(`${name}:upload`);
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        uploads.push({
          url: target,
          body: await new Response(init?.body).text(),
          headers: new Headers(init?.headers),
        });
        return hooks.upload ? hooks.upload() : new Response(null, { status: 204 });
      }
      if (target.pathname.endsWith('/files/write')) {
        events.push(`${name}:panel-write`);
        writes.push({ path: target.searchParams.get('file'), body: String(init?.body) });
        return hooks.panelWrite ? hooks.panelWrite() : new Response(null, { status: 204 });
      }
      throw new Error('Unexpected fixture request');
    });
    return createPterodactylAdapter({
      baseURL: panel,
      applicationKey: 'private-app',
      clientKey: 'private-client',
      uploadOrigins: [wings],
      fileDownloadBinding: 'provider-revision-1',
      fetcher,
      // Separate handles prevent local pending state from masking cross-process use.
      transferCache: { ...cache },
      ...overrides,
    });
  }
  return { process, cache, values, events, uploads, writes, hooks };
}
afterEach(() => vi.restoreAllMocks());

describe('prepared exact-path text writes', () => {
  it.each(['server.properties', 'config/server.properties'])(
    'prepares in API and writes the exact UTF-8 multipart file in worker (%s)',
    async (path) => {
      const f = fixture();
      const api = f.process('api');
      const worker = f.process('worker');
      const content = 'level-name=mondo\r\nmotd=È qui 🌍\n';
      await api.prepareFileWrite('server', path);
      expect(f.uploads).toHaveLength(0);
      expect(f.writes).toHaveLength(0);
      await worker.writeFile('server', path, content);
      expect(f.events.slice(0, 3)).toEqual(['api:settings', 'api:issue', 'worker:upload']);
      expect(f.writes).toHaveLength(0);
      expect(f.uploads).toHaveLength(1);
      const uploaded = f.uploads[0];
      expect(uploaded?.url.searchParams.get('directory')).toBe(
        path.includes('/') ? '/config' : '/',
      );
      expect(uploaded?.url.searchParams.get('token')).toBe('private-1');
      expect(uploaded?.headers.has('authorization')).toBe(false);
      expect(uploaded?.body).toContain('name="files"; filename="server.properties"\r\n');
      expect(uploaded?.body.split('\r\n\r\n')[1]?.split('\r\n--nh-')[0]).toBe(content);
      expect(uploaded?.body.match(/Content-Disposition:/g)).toHaveLength(1);
      await vi.waitFor(() => expect(f.events).toContain('worker:issue'));
      expect(f.events.filter((event) => event.endsWith(':settings'))).toEqual(['api:settings']);
    },
  );

  it('consumes one grant once across concurrent process handles', async () => {
    const f = fixture();
    await f.process('api').prepareFileWrite('server', 'server.properties');
    await Promise.all([
      f.process('first').writeFile('server', 'server.properties', 'one'),
      f.process('second').writeFile('server', 'server.properties', 'two'),
    ]);
    expect(f.uploads).toHaveLength(1);
    expect(f.writes).toHaveLength(1);
    expect(f.uploads[0]?.url.searchParams.get('token')).toBe('private-1');
  });

  it('keeps grants bound to the exact path and server', async () => {
    const f = fixture();
    await f.process('api').prepareFileWrite('server', 'config/server.properties');
    const worker = f.process('worker');
    await worker.writeFile('server', 'server.properties', 'root');
    await worker.writeFile('other', 'config/server.properties', 'other');
    expect(f.uploads).toHaveLength(0);
    expect(f.writes.map((write) => write.body)).toEqual(['root', 'other']);
    await worker.writeFile('server', 'config/server.properties', 'matching');
    expect(f.uploads).toHaveLength(1);
  });

  it.each([
    { applicationKey: 'rotated-app' },
    { clientKey: 'rotated-client' },
    { fileDownloadBinding: 'provider-revision-2' },
    { uploadOrigins: [wings, 'https://other.example.test'] },
    { baseURL: 'https://other-panel.example.test' },
  ])('does not reuse grants after a binding changes (%j)', async (change) => {
    const f = fixture();
    await f.process('api').prepareFileWrite('server', 'server.properties');
    await f.process('worker', change).writeFile('server', 'server.properties', 'content');
    expect(f.uploads).toHaveLength(0);
    expect(f.writes).toHaveLength(1);
  });

  it('uses Panel immediately for an absent grant and does not issue one on demand', async () => {
    const f = fixture();
    await f.process('worker').writeFile('server', 'server.properties', 'content');
    expect(f.events).toEqual(['worker:panel-write']);
  });

  it('retains native writes when no shared cache is configured', async () => {
    const f = fixture();
    const adapter = f.process('native', { transferCache: undefined });
    await adapter.prepareFileWrite('server', 'server.properties');
    await adapter.writeFile('server', 'server.properties', 'content');
    expect(f.events).toEqual(['native:panel-write']);
  });

  it('deduplicates concurrent preparations and reuses an unconsumed grant', async () => {
    const f = fixture();
    const adapter = f.process('api');
    await Promise.all(Array.from({ length: 5 }, () => adapter.prepareFileWrite('server', 'a')));
    await adapter.prepareFileWrite('server', 'a');
    expect(f.events).toEqual(['api:settings', 'api:issue']);
  });

  it('bounds simultaneous preparation work without queuing more paths', async () => {
    const f = fixture();
    let release: ((value: string) => void) | undefined;
    const blocked = new Promise<string>((resolve) => {
      release = resolve;
    });
    const get = vi.fn(async () => blocked);
    const adapter = f.process('api', { transferCache: { ...f.cache, get } });
    const preparations = Array.from({ length: 65 }, (_, index) =>
      adapter.prepareFileWrite('server', `config-${index}.properties`),
    );
    try {
      expect(get).toHaveBeenCalledTimes(64);
      await preparations[64];
      expect(f.events).toHaveLength(0);
    } finally {
      release?.(
        JSON.stringify({
          url: `${wings}/upload/file?token=unused`,
          expiresAt: Date.now() + 900_000,
        }),
      );
      await Promise.all(preparations);
    }
  });

  it('does not wait for pending preparation on the write path', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.hooks.issue = async () => {
      await blocked;
      return Response.json({
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        urls: [`${wings}/upload/file?token=unused`],
      });
    };
    const adapter = f.process('api');
    const preparation = adapter.prepareFileWrite('server', 'server.properties');
    try {
      await vi.waitFor(() => expect(f.events).toContain('api:issue'));
      await adapter.writeFile('server', 'server.properties', 'content');
      expect(f.writes).toHaveLength(1);
      expect(f.uploads).toHaveLength(0);
    } finally {
      release?.();
      await preparation;
    }
  });

  it('expires grants early and falls back without grant issuance', async () => {
    const f = fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await f.process('api').prepareFileWrite('server', 'server.properties');
    clock.mockReturnValue(now + 870_001);
    await f.process('worker').writeFile('server', 'server.properties', 'content');
    expect(f.events).toEqual(['api:settings', 'api:issue', 'worker:panel-write']);
  });

  it.each([-1, 17 * 60_000])('rejects an invalid grant lifetime (%i ms)', async (ttl) => {
    const f = fixture();
    f.hooks.issue = async () =>
      Response.json({
        expiresAt: new Date(Date.now() + ttl).toISOString(),
        urls: [`${wings}/upload/file?token=unused`],
      });
    await f.process('api').prepareFileWrite('server', 'server.properties');
    await f.process('worker').writeFile('server', 'server.properties', 'content');
    expect(f.uploads).toHaveLength(0);
    expect(f.writes).toHaveLength(1);
  });

  it.each(['get', 'put', 'take'] as const)(
    'uses the native write after shared cache %s failure',
    async (operation) => {
      const f = fixture();
      f.cache[operation] = async () => {
        throw new Error('private cache failure');
      };
      await f.process('api').prepareFileWrite('server', 'server.properties');
      await f.process('worker').writeFile('server', 'server.properties', 'content');
      expect(f.uploads).toHaveLength(0);
      expect(f.writes).toHaveLength(1);
    },
  );

  it('discards a grant after an ambiguous atomic take and writes only through Panel', async () => {
    const f = fixture();
    await f.process('api').prepareFileWrite('server', 'server.properties');
    const take = f.cache.take;
    f.cache.take = async (key) => {
      await take(key);
      throw new Error('lost cache reply');
    };
    await f.process('worker').writeFile('server', 'server.properties', 'content');
    expect(f.uploads).toHaveLength(0);
    expect(f.writes).toHaveLength(1);
  });

  it('keeps only shared authority after an ambiguously acknowledged publication', async () => {
    const f = fixture();
    const put = f.cache.put;
    f.cache.put = async (key, value, ttl) => {
      await put(key, value, ttl);
      throw new Error('lost cache reply');
    };
    const api = f.process('api');
    await api.prepareFileWrite('server', 'server.properties');
    await Promise.all([
      api.writeFile('server', 'server.properties', 'api'),
      f.process('worker').writeFile('server', 'server.properties', 'worker'),
    ]);
    expect(f.uploads).toHaveLength(1);
    expect(f.writes).toHaveLength(1);
  });

  it.each(['lost-ack', 'http-error'])(
    'preserves an uncertain Wings write without replay or Panel fallback (%s)',
    async (failure) => {
      const f = fixture();
      await f.process('api').prepareFileWrite('server', 'server.properties');
      f.hooks.upload = async () => {
        if (failure === 'lost-ack') throw new Error('lost private provider reply');
        return new Response('private upstream error', { status: 500 });
      };
      const result = f.process('worker').writeFile('server', 'server.properties', 'changed');
      await expect(result).rejects.toMatchObject({ outcome: 'unknown' });
      await expect(result).rejects.not.toSatisfy(isUploadNotDispatched);
      expect(f.uploads).toHaveLength(1);
      expect(f.writes).toHaveLength(0);
    },
  );

  it('retains native write errors unchanged when no prepared grant exists', async () => {
    const f = fixture();
    f.hooks.panelWrite = async () => new Response(null, { status: 403 });
    await expect(
      f.process('worker').writeFile('server', 'server.properties', 'content'),
    ).rejects.toMatchObject({ reason: 'permission_denied', upstreamStatus: 403 });
  });

  it.each([
    '../server.properties',
    '/server.properties',
    'config%2fserver.properties',
    'config\\server.properties',
    'server.properties\r\nx',
  ])('rejects unsafe paths before preparing or writing (%j)', async (path) => {
    const f = fixture();
    const adapter = f.process('api');
    await expect(adapter.prepareFileWrite('server', path)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(() => adapter.writeFile('server', path, 'content')).toThrow();
    expect(f.events).toHaveLength(0);
  });

  it('keeps the UTF-8 byte limit before cache consumption', async () => {
    const f = fixture();
    const take = vi.spyOn(f.cache, 'take');
    const adapter = f.process('worker');
    expect(() => adapter.writeFile('server', 'server.properties', 'è'.repeat(524289))).toThrow();
    expect(take).not.toHaveBeenCalled();
    expect(f.events).toHaveLength(0);
  });

  it.each([
    `${wings}/upload/file?token=a&token=b`,
    `${wings}/upload/file`,
    `${wings}/delete?token=a`,
    'https://untrusted.example.test/upload/file?token=a',
  ])('does not publish malformed or untrusted grants (%s)', async (url) => {
    const f = fixture();
    f.hooks.issue = async () =>
      Response.json({ expiresAt: new Date(Date.now() + 900_000).toISOString(), urls: [url] });
    await f.process('api').prepareFileWrite('server', 'server.properties');
    await f.process('worker').writeFile('server', 'server.properties', 'content');
    expect(f.uploads).toHaveLength(0);
    expect(f.writes).toHaveLength(1);
  });

  it('records only static write stages and leaves detached refills out of the caller trace', async () => {
    const f = fixture();
    await f.process('api').prepareFileWrite('server', 'server.properties');
    const names: string[] = [];
    const timing: FileReadTiming = {
      async measure(name, work) {
        names.push(name);
        return work();
      },
      measureSync(name, work) {
        names.push(name);
        return work();
      },
    };
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.hooks.issue = async () => {
      await blocked;
      return Response.json({
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        urls: [`${wings}/upload/file?token=refill`],
      });
    };
    try {
      await f.process('worker').writeFile('server', 'server.properties', 'content', timing);
      expect(names).toEqual(['file.write.prepared', 'file.write.http']);
      release?.();
      await vi.waitFor(() => expect(f.events).toContain('worker:issue'));
      expect(names).toEqual(['file.write.prepared', 'file.write.http']);
      const keys = [...f.values.keys()].join(' ');
      for (const privateValue of ['private-app', 'private-client', 'server.properties', wings])
        expect(keys + names.join(' ')).not.toContain(privateValue);
    } finally {
      release?.();
    }
  });
});
