import { Readable } from 'node:stream';
import { readArchiveFile, visitArchive } from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import type { PterodactylAdapter, ServerFile } from '@nickhosting/pterodactyl-adapter';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
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
function fixture() {
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
    ) => work('provider', {}, {}),
  );
  const service = {
    adapter,
    access,
    assertFileMutation: vi.fn(async () => {}),
    authorizeTransfer: vi.fn(async () => {}),
  };
  return { entries, contents, adapter, service };
}
vi.mock('@nickhosting/database', () => ({ recordAudit: vi.fn(async () => {}) }));
describe('file browsing and streaming ZIP', () => {
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
