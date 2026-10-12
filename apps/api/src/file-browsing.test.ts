import { Readable } from 'node:stream';
import { readArchiveFile, visitArchive } from '@nickhosting/content-providers';
import { DomainError, SecretCodec } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { PterodactylAdapter, ServerFile } from '@nickhosting/pterodactyl-adapter';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import {
  type FileMutationContext,
  trustedGameModules,
} from '../../../packages/server-management/src/game-modules.js';
import { createMinecraftModuleRuntime } from '../../../packages/server-management/src/minecraft-module.js';
import {
  collectArchiveEntries,
  fileRevision,
  registerFileBrowsingRoutes,
  streamFileZip,
} from './file-browsing.js';
import type { ServerRouteOptions } from './servers.js';

const file = (name: string, is_file = true, size = 3): ServerFile => ({
  name,
  is_file,
  size,
  is_symlink: false,
  mode: 'rw-r--r--',
  mode_bits: '644',
  mimetype: 'text/plain',
  created_at: '2026-01-01T00:00:00Z',
  modified_at: '2026-01-01T00:00:00Z',
});
function fixture(serverName = 'Fixture server') {
  const entries = new Map([
    ['', [file('a.txt'), file('folder', false)]],
    ['folder', [file('b.txt')]],
  ]);
  const contents = new Map([
    ['a.txt', Buffer.from('one')],
    ['folder/b.txt', Buffer.from('two')],
  ]);
  const adapter = {
    listFiles: vi.fn(async (_id: string, path: string) => entries.get(path) ?? []),
    readFile: vi.fn(async (_id: string, path: string) => contents.get(path)),
    writeFile: vi.fn(async (_id: string, path: string, text: string) => {
      contents.set(path, Buffer.from(text));
    }),
  } as unknown as PterodactylAdapter;
  const access = vi.fn(
    async (
      _ctx: unknown,
      _server: string,
      _write: boolean,
      work: (...args: unknown[]) => unknown,
    ) => work('provider', {}, {}, { name: serverName }),
  );
  const service = {
    adapter,
    access,
    assertFileMutation: vi.fn(
      async (
        _server: string,
        _paths: readonly string[],
        _connection: unknown,
        _context?: FileMutationContext,
      ) => {},
    ),
    authorizeTransfer: vi.fn(async () => {}),
  };
  return { entries, contents, adapter, service };
}
/** Exercise the real Minecraft filesystem guards; only database storage is isolated. */
function minecraftGuard(f: ReturnType<typeof fixture>) {
  expect(trustedGameModules.get('minecraft-java')).toBeDefined();
  const rows: Record<string, unknown> = {
    minecraft_server_profiles: {
      combination_id: 'choice',
      installed_manifest: [{ path: 'libraries/runtime.jar' }],
    },
    minecraft_combinations: {
      binding: {
        profile: 'vanilla',
        release: '26.1',
        image: 'fixture:java25',
        imageJavaMajor: 25,
        declaredEggVariables: [],
        bindings: {},
        fixedVariables: {},
        installationKind: 'server-jar',
        artifactPaths: { server: 'server.jar' },
        supportedProperties: [],
      },
    },
    managed_servers: { pterodactyl_identifier: 'provider' },
  };
  const db = {
    selectFrom(table: string) {
      const query = {
        select: () => query,
        selectAll: () => query,
        where: () => query,
        executeTakeFirst: async () => rows[table],
        executeTakeFirstOrThrow: async () => rows[table],
      };
      return query;
    },
  } as unknown as Kysely<Database>;
  const runtime = createMinecraftModuleRuntime({
    db,
    adapter: f.adapter,
    env: {},
    codec: new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: Buffer.alloc(32) } }),
    observedImageDigest: async () => null,
    authorizeJob: async () => {
      throw new Error('unused');
    },
  });
  f.service.assertFileMutation.mockImplementation((server, paths, _connection, context) =>
    runtime.assertFileMutation(server, paths, db, context),
  );
  return { runtime, db };
}
vi.mock('@nickhosting/database', () => ({ recordAudit: vi.fn(async () => {}) }));
describe('file browsing and streaming ZIP', () => {
  function archiveApp(f = fixture(), principal = vi.fn(async () => ({}))) {
    const app = new Hono();
    app.onError((error, c) =>
      c.json(
        { code: error instanceof DomainError ? error.code : 'internal' },
        error instanceof DomainError ? (error.status as 400) : 500,
      ),
    );
    registerFileBrowsingRoutes(
      app as never,
      { principal, management: async () => f.service } as unknown as ServerRouteOptions,
    );
    return { ...f, app, principal };
  }
  it('streams a large URL-encoded POST selection without putting names in the URL', async () => {
    const f = archiveApp();
    const names = Array.from(
      { length: 512 },
      (_, index) => `${index}-${'selected-file-'.repeat(12)}città.txt`,
    );
    f.entries.set(
      '',
      names.map((name) => file(name)),
    );
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    f.adapter.downloadFile = vi.fn(async (_id, target) => ({
      body: new ReadableStream<Uint8Array>({
        async start(controller) {
          if (target === names[0]) await first;
          controller.enqueue(Buffer.from('one'));
          controller.close();
        },
      }),
      contentType: 'application/octet-stream' as const,
      contentLength: 3,
    }));
    const body = new URLSearchParams({ root: '', files: JSON.stringify(names) });
    expect(Buffer.byteLength(body.toString())).toBeGreaterThan(65536);
    const response = await f.app.request('/v1/servers/abc/files/archive', {
      method: 'POST',
      body,
    });
    try {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/zip');
      await vi.waitFor(() => expect(f.adapter.downloadFile).toHaveBeenCalledTimes(1));
      expect(f.adapter.readFile).not.toHaveBeenCalled();
    } finally {
      releaseFirst();
    }
    const extracted: string[] = [];
    await visitArchive(Buffer.from(await response.arrayBuffer()), async (entry) => {
      expect((await readArchiveFile(entry, 100)).toString()).toBe('one');
      extracted.push(entry.path);
    });
    expect(extracted).toEqual(names);
    expect(f.principal).toHaveBeenCalledTimes(1);
    expect(f.service.access).toHaveBeenCalledWith(
      expect.anything(),
      'abc',
      false,
      expect.any(Function),
    );
    expect(f.service.authorizeTransfer.mock.calls.length).toBeGreaterThanOrEqual(names.length);
  });
  it.each([
    ['missing files', 'root='],
    ['malformed JSON', 'files=%5B'],
    ['duplicate files', 'files=%5B%22a.txt%22%5D&files=%5B%22b.txt%22%5D'],
    ['duplicate root', 'root=&root=folder&files=%5B%22a.txt%22%5D'],
    ['unexpected field', 'files=%5B%22a.txt%22%5D&token=untrusted'],
    ['empty selection', 'files=%5B%5D'],
    [
      'selection over the archive entry budget',
      new URLSearchParams({ files: JSON.stringify(Array<string>(10001).fill('a.txt')) }).toString(),
    ],
  ])('rejects a POST manifest with %s before provider access', async (_name, body) => {
    const f = archiveApp();
    const response = await f.app.request('/v1/servers/abc/files/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    });
    expect(response.status).toBe(400);
    expect(f.service.access).not.toHaveBeenCalled();
    expect(f.adapter.listFiles).not.toHaveBeenCalled();
  });
  it('retains session and transfer authorization for POST archives', async () => {
    const f = archiveApp();
    const request = () =>
      f.app.request('/v1/servers/abc/files/archive', {
        method: 'POST',
        body: new URLSearchParams({ root: '', files: '["a.txt"]' }),
      });
    f.principal.mockRejectedValueOnce(new DomainError('unauthenticated'));
    expect((await request()).status).toBe(401);
    expect(f.service.access).not.toHaveBeenCalled();
    f.service.authorizeTransfer.mockRejectedValueOnce(new DomainError('forbidden'));
    expect((await request()).status).toBe(403);
    expect(f.adapter.listFiles).not.toHaveBeenCalled();
  });
  it.each(['application/json', 'multipart/form-data', 'text/plain'])(
    'rejects the unsupported POST manifest content type %s',
    async (contentType) => {
      const f = archiveApp();
      const response = await f.app.request('/v1/servers/abc/files/archive', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: 'files=%5B%22a.txt%22%5D',
      });
      expect(response.status).toBe(400);
      expect(f.service.access).not.toHaveBeenCalled();
    },
  );
  it('keeps the actual recursive entry budget when a selected folder expands', async () => {
    const f = fixture();
    f.entries.set(
      'folder',
      Array.from({ length: 10000 }, (_, index) => file(`${index}.txt`)),
    );
    await expect(
      collectArchiveEntries(f.adapter, 'id', '', ['folder'], async () => {}),
    ).rejects.toMatchObject({ code: 'validation_failed', status: 413 });
  });
  it.each([
    ['  Survival di Nic — Città 26.1!  ', 'survival-di-nic-citta-26-1'],
    ['../"Server"\r\nName', 'server-name'],
    ['🎮 日本語', 'server'],
    ['ﬃ'.repeat(100), `${'ffi'.repeat(33)}f`],
  ])(
    'names ZIP attachments safely from the managed name %s and request time',
    async (name, slug) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
      try {
        const f = fixture(name);
        f.adapter.downloadFile = vi.fn(async () => ({
          body: new Blob(['one']).stream(),
          contentType: 'application/octet-stream' as const,
          contentLength: 3,
        }));
        // Metadata enumeration may finish later; the filename keeps the request time.
        f.adapter.listFiles = vi.fn(async (_id, directory = '') => {
          vi.setSystemTime(new Date('2026-01-02T03:05:20Z'));
          return f.entries.get(directory) ?? [];
        });
        const app = new Hono();
        registerFileBrowsingRoutes(
          app as never,
          {
            principal: async () => ({}),
            management: async () => f.service,
          } as unknown as ServerRouteOptions,
        );
        const response = await app.request(
          `/v1/servers/abc/files/archive?files=${encodeURIComponent(JSON.stringify(['a.txt']))}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-disposition')).toBe(
          `attachment; filename="nhpanel-${slug}-2026-01-02_03_04_05.zip"`,
        );
        expect(response.headers.get('content-type')).toBe('application/zip');
        const contents: string[] = [];
        await visitArchive(Buffer.from(await response.arrayBuffer()), async (entry) => {
          contents.push(`${entry.path}:${(await readArchiveFile(entry, 100)).toString()}`);
        });
        expect(contents).toEqual(['a.txt:one']);
        expect(f.service.access).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('collects selected trees once and includes empty directories', async () => {
    const f = fixture();
    f.entries.set('folder', []);
    const entries = await collectArchiveEntries(
      f.adapter,
      'id',
      '',
      ['a.txt', 'folder'],
      async () => {},
    );
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'folder']);
    const body = streamFileZip(entries, async () => new Blob(['one']).stream());
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
    const extracted: string[] = [];
    await visitArchive(bytes, async (entry) => {
      extracted.push(`${entry.path}:${(await readArchiveFile(entry, 100)).toString()}`);
    });
    expect(extracted).toEqual(['a.txt:one']);
    expect(bytes.includes(Buffer.from('folder/'))).toBe(true);
  });
  it.each(['../a.txt', 'folder/b.txt', '/a.txt'])('rejects unsafe selection %s', async (name) => {
    const f = fixture();
    await expect(
      collectArchiveEntries(f.adapter, 'id', '', [name], async () => {}),
    ).rejects.toThrow();
  });
  it('rejects nested symlinks and revocation before opening streams', async () => {
    const f = fixture();
    f.entries.set('folder', [{ ...file('link'), is_symlink: true }]);
    await expect(
      collectArchiveEntries(f.adapter, 'id', '', ['folder'], async () => {}),
    ).rejects.toThrow();
    await expect(
      collectArchiveEntries(f.adapter, 'id', '', ['a.txt'], async () => {
        throw new DomainError('forbidden');
      }),
    ).rejects.toThrow();
  });
  it('does not fetch all file bodies concurrently', async () => {
    const f = fixture();
    const entries = await collectArchiveEntries(
      f.adapter,
      'id',
      '',
      ['a.txt', 'folder'],
      async () => {},
    );
    const open = vi.fn(async (entry: { path: string }) =>
      new Blob([f.contents.get(entry.path) ?? Buffer.alloc(0)]).stream(),
    );
    const bytes = await new Response(streamFileZip(entries, open)).arrayBuffer();
    expect(open.mock.calls.map(([entry]) => entry.path)).toEqual(['a.txt', 'folder/b.txt']);
    expect(bytes.byteLength).toBeGreaterThan(6);
  });
  it('propagates upstream failure instead of manufacturing a complete archive', async () => {
    const f = fixture();
    const entries = await collectArchiveEntries(f.adapter, 'id', '', ['a.txt'], async () => {});
    await expect(
      new Response(
        streamFileZip(entries, async () => {
          throw new Error('private secret');
        }),
      ).arrayBuffer(),
    ).rejects.toThrow('archive_stream_failed');
  });
  it('cancels the active upstream on client cancellation', async () => {
    const f = fixture();
    const entries = await collectArchiveEntries(f.adapter, 'id', '', ['a.txt'], async () => {});
    let upstream: AbortSignal | undefined;
    const controller = new AbortController();
    const stream = streamFileZip(
      entries,
      async (_entry, signal) => {
        upstream = signal;
        return Readable.toWeb(new Readable({ read() {} })) as ReadableStream<Uint8Array>;
      },
      controller.signal,
    );
    const reader = stream.getReader();
    await reader.read();
    controller.abort();
    await vi.waitFor(() => expect(upstream?.aborted).toBe(true));
    await reader.cancel().catch(() => {});
  });
});
describe('editor revisions', () => {
  function appFixture() {
    const f = fixture();
    const app = new Hono();
    app.onError((e, c) =>
      c.json(
        { code: e instanceof DomainError ? e.code : 'internal' },
        e instanceof DomainError ? (e.status as 400) : 500,
      ),
    );
    registerFileBrowsingRoutes(
      app as never,
      {
        principal: async () => ({}),
        management: async () => f.service,
      } as unknown as ServerRouteOptions,
    );
    return { ...f, app };
  }
  it.each(['server.jar', 'world.dat', 'r.0.0.mca', 'backup.zip', 'icon.png'])(
    'rejects editing %s before downloading its body, even with text MIME',
    async (name) => {
      const f = appFixture();
      f.entries.get('')?.push(file(name));
      const response = await f.app.request(`/v1/servers/abc/files/editor?path=${name}`);
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ code: 'file_not_editable' });
      expect(f.adapter.readFile).not.toHaveBeenCalled();
    },
  );
  it.each(['server.jar', 'level.dat', 'backup.7z'])(
    'refuses creating binary target %s through the text PUT endpoint',
    async (name) => {
      const f = appFixture();
      const response = await f.app.request('/v1/servers/abc/files/editor', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: name, content: 'text', expectedRevision: null }),
      });
      expect(response.status).toBe(415);
      expect(f.adapter.readFile).not.toHaveBeenCalled();
      expect(f.adapter.writeFile).not.toHaveBeenCalled();
    },
  );
  it.each([Buffer.from([0xc3, 0x28]), Buffer.from('binary\0data'), Buffer.from('%PDF-1.7\nhello')])(
    'refuses binary bytes renamed to text on both read and matching-revision save',
    async (bytes) => {
      const f = appFixture();
      f.contents.set('a.txt', bytes);
      const response = await f.app.request('/v1/servers/abc/files/editor?path=a.txt');
      expect(response.status).toBe(415);
      const save = await f.app.request('/v1/servers/abc/files/editor', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: 'a.txt',
          content: 'replacement',
          expectedRevision: fileRevision(bytes),
        }),
      });
      expect(save.status).toBe(415);
      expect(f.adapter.writeFile).not.toHaveBeenCalled();
      expect(f.contents.get('a.txt')).toEqual(bytes);
    },
  );
  it.each(['invalid\0data', 'control\x01data', '%PDF-1.7', '\ud800'])(
    'refuses submitted binary controls, signatures and lossy surrogate encoding',
    async (content) => {
      const f = appFixture();
      const save = await f.app.request('/v1/servers/abc/files/editor', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'new.txt', content, expectedRevision: null }),
      });
      expect(save.status).toBe(415);
      expect(f.adapter.writeFile).not.toHaveBeenCalled();
    },
  );
  it('allows genuine unknown-extension UTF-8/octet-stream files and preserves revision saves', async () => {
    const f = appFixture();
    const name = 'custom.unknown';
    const content = '\ufeff# città 日本語\nkey=value';
    f.entries.get('')?.push({ ...file(name), mimetype: 'application/octet-stream' });
    f.contents.set(name, Buffer.from(content));
    const read = await f.app.request(`/v1/servers/abc/files/editor?path=${name}`);
    const loaded = await read.json();
    expect(read.status).toBe(200);
    expect(loaded.content).toBe(content);
    const save = await f.app.request('/v1/servers/abc/files/editor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: name,
        content: `${content}\nnext=true`,
        expectedRevision: loaded.revision,
      }),
    });
    expect(save.status).toBe(200);
    expect(f.contents.get(name)?.toString()).toBe(`${content}\nnext=true`);
  });
  it('retains the editor byte limit without reading a known oversize file', async () => {
    const f = appFixture();
    f.entries.set('', [file('huge.txt', true, 1048577)]);
    const response = await f.app.request('/v1/servers/abc/files/editor?path=huge.txt');
    expect(response.status).toBe(413);
    expect(f.adapter.readFile).not.toHaveBeenCalled();
  });
  it('reads a revision and rejects a changed provider file before writing', async () => {
    const f = appFixture();
    const response = await f.app.request('/v1/servers/abc/files/editor?path=a.txt');
    const loaded = await response.json();
    expect(loaded).toEqual({ content: 'one', revision: fileRevision(Buffer.from('one')) });
    f.contents.set('a.txt', Buffer.from('changed'));
    const write = await f.app.request('/v1/servers/abc/files/editor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'a.txt', content: 'new', expectedRevision: loaded.revision }),
    });
    expect(write.status).toBe(409);
    expect(f.adapter.writeFile).not.toHaveBeenCalled();
  });
  it('new-file null revision cannot overwrite an existing file', async () => {
    const f = appFixture();
    const response = await f.app.request('/v1/servers/abc/files/editor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'a.txt', content: 'new', expectedRevision: null }),
    });
    expect(response.status).toBe(409);
    expect(f.adapter.writeFile).not.toHaveBeenCalled();
  });
  it('saves matching revisions and returns the verified new revision', async () => {
    const f = appFixture();
    const response = await f.app.request('/v1/servers/abc/files/editor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'a.txt',
        content: 'new',
        expectedRevision: fileRevision(Buffer.from('one')),
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: fileRevision(Buffer.from('new')) });
  });
  it('shares nested directory preflight between real Minecraft and generic guards, retaining read/write/read verification', async () => {
    const f = appFixture();
    minecraftGuard(f);
    const response = await f.app.request('/v1/servers/abc/files/editor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'folder/b.txt',
        content: 'new',
        expectedRevision: fileRevision(Buffer.from('two')),
      }),
    });
    expect(response.status).toBe(200);
    expect(f.adapter.listFiles).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.adapter.listFiles).mock.calls).toEqual([
      ['provider', ''],
      ['provider', 'folder'],
    ]);
    expect(vi.mocked(f.adapter.readFile).mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['provider', 'folder/b.txt'],
      ['provider', 'folder/b.txt'],
    ]);
    const reads = vi.mocked(f.adapter.readFile).mock.invocationCallOrder;
    const write = vi.mocked(f.adapter.writeFile).mock.invocationCallOrder[0] ?? 0;
    expect(reads[0]).toBeLessThan(write);
    expect(reads[1]).toBeGreaterThan(write);
    expect(await response.json()).toEqual({ revision: fileRevision(Buffer.from('new')) });

    // A subsequent authorized request must see a newly introduced provider symlink.
    f.entries.set('', [file('a.txt'), { ...file('folder', false), is_symlink: true }]);
    vi.mocked(f.adapter.listFiles).mockClear();
    const previousContentReads = vi.mocked(f.adapter.readFile).mock.calls.length;
    const next = await f.app.request('/v1/servers/abc/files/editor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'folder/b.txt',
        content: 'next',
        expectedRevision: fileRevision(Buffer.from('new')),
      }),
    });
    expect(next.status).toBe(409);
    // The existing parallel ancestor preflight reads both directories afresh,
    // then rejects the symlink before another content read or write can start.
    expect(vi.mocked(f.adapter.listFiles).mock.calls).toEqual([
      ['provider', ''],
      ['provider', 'folder'],
    ]);
    expect(f.adapter.readFile).toHaveBeenCalledTimes(previousContentReads);
    expect(f.adapter.writeFile).toHaveBeenCalledTimes(1);
  });
  it.each(['case-alias', 'duplicate-alias', 'symlink', 'file-ancestor'])(
    'preserves %s rejection with shared preflight observations',
    async (kind) => {
      const f = appFixture();
      minecraftGuard(f);
      if (kind === 'case-alias') f.entries.set('', [file('Folder', false)]);
      if (kind === 'duplicate-alias')
        f.entries.set('', [file('folder', false), file('Folder', false)]);
      if (kind === 'symlink') f.entries.set('', [{ ...file('folder', false), is_symlink: true }]);
      if (kind === 'file-ancestor') f.entries.set('', [file('folder')]);
      const response = await f.app.request('/v1/servers/abc/files/editor', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: 'folder/b.txt',
          content: 'replacement',
          expectedRevision: fileRevision(Buffer.from('two')),
        }),
      });
      expect(response.status).toBe(kind === 'file-ancestor' ? 403 : 409);
      expect(f.adapter.writeFile).not.toHaveBeenCalled();
      expect(f.adapter.readFile).not.toHaveBeenCalled();
    },
  );
  it('preserves protected runtime paths and refuses a preflight bound to another provider server', async () => {
    const f = appFixture();
    const { runtime, db } = minecraftGuard(f);
    const listFiles = vi.fn(async () => [] as ServerFile[]);
    await expect(
      runtime.assertFileMutation('abc', ['folder/b.txt'], db, {
        providerIdentifier: 'foreign',
        listFiles,
      }),
    ).rejects.toThrow('conflict');
    expect(listFiles).not.toHaveBeenCalled();
    await expect(
      runtime.assertFileMutation('abc', ['libraries'], db, {
        providerIdentifier: 'provider',
        listFiles,
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'minecraft_runtime_file_protected' },
    });
    expect(listFiles).not.toHaveBeenCalled();
    expect(f.adapter.writeFile).not.toHaveBeenCalled();
  });
  it('rechecks authorization after remote reads and refuses a revoked write', async () => {
    const f = appFixture();
    f.service.authorizeTransfer.mockRejectedValueOnce(new DomainError('forbidden'));
    const response = await f.app.request('/v1/servers/abc/files/editor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'a.txt',
        content: 'new',
        expectedRevision: fileRevision(Buffer.from('one')),
      }),
    });
    expect(response.status).toBe(403);
    expect(f.adapter.writeFile).not.toHaveBeenCalled();
  });
  it('detects a provider change immediately after a write', async () => {
    const f = appFixture();
    vi.mocked(f.adapter.writeFile).mockImplementation(async () => {
      f.contents.set('a.txt', Buffer.from('external'));
    });
    const response = await f.app.request('/v1/servers/abc/files/editor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'a.txt',
        content: 'new',
        expectedRevision: fileRevision(Buffer.from('one')),
      }),
    });
    expect(response.status).toBe(409);
  });
});
