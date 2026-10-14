import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type AuthContext, createLogger, DomainError, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { authorizeServer, type ManagementRuntime } from '@nickhosting/server-management';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { closeFileViewers, closeViewerArchives, registerFileViewerRoutes } from './file-viewers.js';
import { ViewerCache } from './viewer-cache.js';
import { FileViewerService } from './viewer-service.js';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let fixture: Awaited<ReturnType<typeof managementFixture>>;
let app: Hono<{ Variables: Variables }>;
let actor: AuthContext;
let id: string;
let root: string;
let cache: ViewerCache;
let content: Buffer;
let reads: number;
let streams: number;
const closeSource = vi.fn(async () => {});
let sourceRevision: number;
let revoked: AbortController;
let debugTiming = false;
const timingLogs = vi.fn();
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 17) } });
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  fixture = await managementFixture(db.db, { interactive: true });
  id = await fixture.server();
  actor = fixture.context;
  root = await mkdtemp(join(tmpdir(), 'nh-viewer-http-'));
  cache = new ViewerCache({ root });
  content = Buffer.from('0123456789');
  reads = 0;
  streams = 0;
  closeSource.mockClear();
  sourceRevision = 1;
  revoked = new AbortController();
  vi.spyOn(FileViewerService.prototype, 'open').mockImplementation(
    async (context, _runtime, serverId, path) => {
      await authorizeServer(db.db, context, serverId, 'server:read');
      if (revoked.signal.aborted) throw new DomainError('forbidden');
      return {
        source: {
          size: content.length,
          mtimeMs: sourceRevision,
          read: async (offset, length) => {
            reads++;
            return content.subarray(offset, offset + length);
          },
          stream: (start = 0, end = content.length) => {
            streams++;
            return new ReadableStream({
              start(c) {
                c.enqueue(content.subarray(start, end));
                c.close();
              },
            });
          },
        },
        path,
        signal: revoked.signal,
        cache,
        key: `${id}:${path}:${sourceRevision}`,
        close: closeSource,
        restat: async () => ({ size: content.length, mtimeMs: sourceRevision, mode: 0o644 }),
        siblingExists: async () => false,
      };
    },
  );
  app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  debugTiming = false;
  timingLogs.mockClear();
  const logger = createLogger(timingLogs, { level: 'debug' });
  vi.spyOn(logger, 'isEnabled').mockImplementation((level) => level !== 'debug' || debugTiming);
  registerFileViewerRoutes(app, {
    logger,
    db: db.db,
    codec,
    env: {},
    principal: async () => actor,
    management: async () => ({}) as ManagementRuntime,
    acquireUploadSlot: () => () => {},
  });
});
afterEach(async () => {
  await closeViewerArchives(db.db);
  await closeFileViewers(db.db);
  await cache.close();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const request = (suffix: string, options?: RequestInit) =>
  app.request(`/v1/servers/${id}/files/viewer${suffix}`, options);
const put = (value: unknown) =>
  request('/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });

describe('viewer routes with isolated database and fixture byte source', () => {
  it('serves Datagrid first-page/schema, filtered stable rows and revision-bound cell detail through shared authorization', async () => {
    const path = join(root, 'fixture.db');
    const database = new DatabaseSync(path);
    database.exec(
      'CREATE TABLE data (id INTEGER PRIMARY KEY, category TEXT, text TEXT, bytes BLOB)',
    );
    const insert = database.prepare('INSERT INTO data VALUES (?,?,?,?)');
    for (let index = 0; index < 205; index++)
      insert.run(
        index,
        'same',
        index === 204 ? '😀'.repeat(70000) : `record ${index}`,
        new Uint8Array(5),
      );
    database.close();
    content = await readFile(path);
    const original = Buffer.from(content);
    const response = await request('/sqlite?path=fixture.db');
    expect(response.status).toBe(200);
    const first = await response.json();
    expect(first).toMatchObject({
      tables: ['data'],
      table: 'data',
      columns: ['id', 'category', 'text', 'bytes'],
      schema: [
        { name: 'id', primaryKey: true },
        { name: 'category' },
        { name: 'text' },
        { name: 'bytes' },
      ],
      offset: 0,
      hasMore: true,
      consistency: 'unverified',
      revision: expect.any(String),
    });
    expect(first.rows).toHaveLength(100);
    const initialReads = reads;
    const second = await request(
      '/sqlite?path=fixture.db&table=data&offset=100&sort=category&direction=desc',
    );
    expect((await second.json()).rows[0][0]).toEqual({ type: 'integer', value: '100' });
    const query = new URLSearchParams({
      path: 'fixture.db',
      table: 'data',
      sort: 'id',
      direction: 'desc',
      query: 'same',
      filterColumn: 'category',
      rowOffset: '0',
      column: 'text',
      revision: first.revision,
    });
    const details = await request(`/sqlite/cell?${query}`);
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({
      cell: { type: 'text', value: '😀'.repeat(65536), truncated: true },
      nextStart: 65536,
      totalCharacters: 70000,
    });
    query.set('start', '65536');
    expect(await (await request(`/sqlite/cell?${query}`)).json()).toMatchObject({
      cell: { value: '😀'.repeat(4464), truncated: false },
      nextStart: null,
    });
    expect(reads).toBe(initialReads);
    expect(FileViewerService.prototype.open).toHaveBeenCalledTimes(4);
    expect(await readFile(path)).toEqual(original);
    actor = { ...fixture.context, actorUserId: randomUUID(), subjectUserId: randomUUID() };
    expect((await request(`/sqlite/cell?${query}`)).status).toBe(403);
    expect((await request('/sqlite?path=fixture.db')).status).toBe(403);
    expect(reads).toBe(initialReads);
    actor = fixture.context;
    sourceRevision++;
    query.set('column', 'does-not-exist');
    const stale = await request(`/sqlite/cell?${query}`);
    expect(stale.status).toBe(422);
    expect(await stale.json()).toMatchObject({
      error: { code: 'viewer_sqlite_changed', messageKey: 'viewer.sqliteChanged' },
    });
    revoked.abort();
    const beforeRevoked = reads;
    expect((await request(`/sqlite/cell?${query}`)).status).toBe(403);
    expect(reads).toBe(beforeRevoked);
  });
  it('returns an empty SQLite database and rejects malformed paging before reading', async () => {
    for (const suffix of [
      'offset=-1',
      'offset=1000001',
      'direction=sideways',
      `query=${'a'.repeat(201)}`,
    ])
      expect((await request(`/sqlite?path=empty.db&${suffix}`)).status).toBe(400);
    expect(FileViewerService.prototype.open).not.toHaveBeenCalled();
    const path = join(root, 'empty.db');
    const database = new DatabaseSync(path);
    database.exec('VACUUM');
    database.close();
    content = await readFile(path);
    const empty = await request('/sqlite?path=empty.db');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      tables: [],
      columns: [],
      schema: [],
      rows: [],
      hasMore: false,
    });
  });
  it('collects bounded debug browser timings only after server authorization without opening files', async () => {
    const traceId = randomUUID();
    const post = (body: unknown) =>
      request('/motion-timing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const valid = { traceId, events: [{ phase: 'native.play', atMs: 10 }] };
    expect((await post(valid)).status).toBe(404);
    expect(await (await request('/capabilities')).json()).not.toHaveProperty('debugTiming');
    debugTiming = true;
    expect(await (await request('/capabilities')).json()).toHaveProperty('debugTiming', true);
    expect((await post(valid)).status).toBe(204);
    expect(timingLogs.mock.calls.at(-1)?.[0]).toMatchObject({
      event: 'viewer.motion_browser',
      data: { source: 'browser', traceId, events: valid.events },
    });
    expect(
      (await post({ traceId, events: [{ phase: 'native.play', atMs: 10, path: '/private' }] }))
        .status,
    ).toBe(400);
    actor = { ...fixture.context, actorUserId: randomUUID(), subjectUserId: randomUUID() };
    expect((await post(valid)).status).toBe(403);
    expect(FileViewerService.prototype.open).not.toHaveBeenCalled();
  });
  it('correlates debug Range timings and leaves disabled responses and bytes unchanged', async () => {
    const traceId = randomUUID();
    const suffix = `/content?path=/private.mkv&motionTrace=${traceId}&motionPurpose=native`;
    const disabled = await request(suffix, { headers: { Range: 'bytes=2-4' } });
    expect(await disabled.text()).toBe('234');
    expect(disabled.headers.has('server-timing')).toBe(false);
    expect(timingLogs).not.toHaveBeenCalled();
    debugTiming = true;
    const enabled = await request(suffix, { headers: { Range: 'bytes=2-4' } });
    expect(enabled.status).toBe(206);
    expect(await enabled.text()).toBe('234');
    expect(enabled.headers.get('server-timing')).toMatch(/^nh-motion;dur=/);
    await vi.waitFor(() => expect(timingLogs).toHaveBeenCalledTimes(1));
    expect(timingLogs.mock.calls[0]?.[0]).toMatchObject({
      event: 'viewer.motion_request',
      data: { traceId, purpose: 'native', bytes: 3, outcome: 'succeeded' },
    });
    expect(JSON.stringify(timingLogs.mock.calls)).not.toContain('/private.mkv');
  });

  it('reports unconfigured optional transport without constructing it or accessing provider state', async () => {
    const response = await request('/capabilities');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: false });
    expect(FileViewerService.prototype.open).not.toHaveBeenCalled();
  });
  it('keeps personal server/game/global preferences scoped and validates first-party IDs', async () => {
    expect((await put({ scope: 'server', extension: 'json', viewerId: 'text' })).status).toBe(204);
    expect((await put({ scope: 'server', extension: 'pdf', viewerId: 'pdf' })).status).toBe(204);
    expect(
      (await put({ scope: 'game', extension: 'dat', viewerId: 'fixture:binary' })).status,
    ).toBe(204);
    expect(
      (await put({ scope: 'global', extension: 'png', viewerId: 'https://untrusted.test/code.js' }))
        .status,
    ).toBe(400);
    expect(await (await request('/preferences')).json()).toMatchObject({
      preferences: expect.arrayContaining([
        { scope: 'server', extension: 'json', viewerId: 'text' },
        { scope: 'server', extension: 'pdf', viewerId: 'pdf' },
        { scope: 'game', extension: 'dat', viewerId: 'fixture:binary' },
      ]),
    });
    actor = fixture.owner;
    expect(await (await request('/preferences')).json()).toEqual({ preferences: [] });
  });
  it('refuses a foreign principal before source reads and preference changes', async () => {
    actor = { ...fixture.context, actorUserId: randomUUID(), subjectUserId: randomUUID() };
    expect((await request('/content?path=private.png')).status).toBe(403);
    expect((await put({ scope: 'server', extension: 'png', viewerId: 'image' })).status).toBe(403);
    expect(reads).toBe(0);
  });
  it('streams exact ranges, suffixes, safe SVG headers and Unicode download names', async () => {
    const range = await request('/content?path=vector.svg', { headers: { Range: 'bytes=2-5' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await range.text()).toBe('2345');
    expect(range.headers.get('content-security-policy')).toContain('sandbox');
    expect(range.headers.get('x-content-type-options')).toBe('nosniff');
    const suffix = await request('/content?path=a.mp4', { headers: { Range: 'bytes=-2' } });
    expect(await suffix.text()).toBe('89');
    const invalid = await request('/content?path=a.mp4', { headers: { Range: 'bytes=1-2,4-6' } });
    expect(invalid.status).toBe(416);
    const download = await request('/content?path=caf%C3%A9.png&download=true');
    expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''caf%C3%A9.png");
    await download.arrayBuffer();
  });
  it('pins physical ranges to uncached metadata and rejects changed revisions before streaming', async () => {
    const metadata = await request('?path=document.pdf');
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('cache-control')).toBe('no-store');
    const { revision } = await metadata.json();
    expect(revision).toBe(`${id}:document.pdf:1`);
    expect(reads).toBe(0);
    expect(streams).toBe(0);
    const headers = { 'If-Match': `"${revision}"`, Range: 'bytes=2-5' };
    const range = await request('/content?path=document.pdf', { headers });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('2345');
    expect(streams).toBe(1);
    sourceRevision++;
    content = Buffer.from('abcdefghij');
    const closedBefore = closeSource.mock.calls.length;
    const stale = await request('/content?path=document.pdf', { headers });
    expect(stale.status).toBe(412);
    expect(await stale.text()).toBe('');
    expect(stale.headers.get('cache-control')).toBe('no-store');
    expect(reads).toBe(0);
    expect(streams).toBe(1);
    expect(closeSource).toHaveBeenCalledTimes(closedBefore + 1);
    const unpinned = await request('/content?path=document.pdf', {
      headers: { Range: 'bytes=2-5' },
    });
    expect(await unpinned.text()).toBe('cdef');
  });
  it('rejects stale archive member pins before opening or streaming a retained member', async () => {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from('member'), 'document.pdf');
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    content = Buffer.concat(chunks);
    const { revision } = await (await request('?path=fixture.zip')).json();
    const headers = { 'If-Match': `"${revision}"`, Range: 'bytes=1-3' };
    const member = await request('/archive/content?path=fixture.zip&entry=document.pdf', {
      headers,
    });
    expect(member.status).toBe(206);
    expect(await member.text()).toBe('emb');
    const indexedReads = reads;
    const openedStreams = streams;
    const closedBefore = closeSource.mock.calls.length;
    sourceRevision++;
    const stale = await request('/archive/content?path=fixture.zip&entry=document.pdf', {
      headers,
    });
    expect(stale.status).toBe(412);
    expect(await stale.text()).toBe('');
    expect(reads).toBe(indexedReads);
    expect(streams).toBe(openedStreams);
    expect(closeSource).toHaveBeenCalledTimes(closedBefore + 1);
  });
  it('checks permission and revocation before evaluating a stale revision pin', async () => {
    const { revision } = await (await request('?path=document.pdf')).json();
    sourceRevision++;
    const headers = { 'If-Match': `"${revision}"` };
    actor = { ...fixture.context, actorUserId: randomUUID(), subjectUserId: randomUUID() };
    for (const suffix of [
      '/content?path=document.pdf',
      '/archive/content?path=fixture.zip&entry=document.pdf',
    ])
      expect((await request(suffix, { headers })).status).toBe(403);
    actor = fixture.context;
    revoked.abort();
    expect((await request('/content?path=document.pdf', { headers })).status).toBe(403);
    expect(reads).toBe(0);
    expect(streams).toBe(0);
  });
  it('indexes a ZIP once, navigates retained metadata and downloads only a chosen member', async () => {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from('member'), 'folder/a.txt');
    zip.addBuffer(Buffer.from('other'), 'folder/b.txt');
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    content = Buffer.concat(chunks);
    const listing = await request('/archive?path=fixture.zip');
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({ entries: [{ name: 'folder', directory: true }] });
    const indexedReads = reads;
    const next = await request('/archive?path=fixture.zip&directory=folder');
    expect(next.status).toBe(200);
    expect((await next.json()).entries).toHaveLength(2);
    expect(reads).toBe(indexedReads);
    const body = await request('/archive/content?path=fixture.zip&entry=folder/a.txt', {
      headers: { Range: 'bytes=1-3' },
    });
    expect(body.status).toBe(206);
    expect(await body.text()).toBe('emb');
  });
  it('lists nested archives with search/sort and streams a scoped selection ZIP', async () => {
    const makeZip = async (files: Record<string, Buffer>) => {
      const zip = new ZipFile();
      for (const [name, bytes] of Object.entries(files)) zip.addBuffer(bytes, name);
      zip.end();
      const chunks: Buffer[] = [];
      for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    };
    content = await makeZip({
      'inside.zip': await makeZip({
        'folder/a.txt': Buffer.from('small'),
        'folder/b.txt': Buffer.from('larger text'),
        'other.txt': Buffer.from('exclude'),
      }),
    });
    const params = new URLSearchParams({
      path: 'outer.zip',
      archives: JSON.stringify(['inside.zip']),
    });
    const listing = await request(`/archive?${params}&directory=folder&sort=size&direction=desc`);
    expect(listing.status).toBe(200);
    expect((await listing.json()).entries.map((entry: { name: string }) => entry.name)).toEqual([
      'b.txt',
      'a.txt',
    ]);
    const searched = await request(`/archive?${params}&directory=folder&query=a.txt`);
    expect((await searched.json()).entries).toHaveLength(1);
    const count = reads;
    const member = await request(`/archive/content?${params}&entry=folder/a.txt`);
    expect(await member.text()).toBe('small');
    expect(reads).toBe(count);
    const downloaded = await request(`/archive/download?${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        directory: 'folder/',
        entries: JSON.stringify(['folder/a.txt']),
      }),
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-type')).toBe('application/zip');
    const output = Buffer.from(await downloaded.arrayBuffer());
    const { createArchiveViewer } = await import('./viewer-archive.js');
    const { Readable } = await import('node:stream');
    const verify = await createArchiveViewer(
      {
        size: output.length,
        mtimeMs: 1,
        read: async (offset, length) => output.subarray(offset, offset + length),
        stream: (start = 0, end = output.length) =>
          Readable.toWeb(
            Readable.from([output.subarray(start, end)]),
          ) as ReadableStream<Uint8Array>,
      },
      { name: 'selection.zip', key: 'verify', cache },
    );
    try {
      expect(verify.list().entries.map((entry) => entry.path)).toEqual(['a.txt']);
      expect(await new Response((await verify.open('a.txt')).stream).text()).toBe('small');
    } finally {
      verify.close();
    }
    const invalid = await request(
      `/archive/download?${params}&directory=folder&entries=${encodeURIComponent(JSON.stringify(['other.txt']))}`,
    );
    expect(invalid.status).toBe(422);
    const deep = await request(
      `/archive?path=outer.zip&archives=${encodeURIComponent(JSON.stringify(['a', 'b', 'c', 'd', 'e']))}`,
    );
    expect(deep.status).toBe(400);
  });
  it('does not hide ZIP CRC failure after streaming the full declared member', async () => {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from('member'), 'a.txt');
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    content = Buffer.concat(chunks);
    const central = content.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    content.writeUInt32LE((content.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
    const response = await request('/archive/content?path=bad.zip&entry=a.txt');
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
  it('does not route a nonexistent managed ID to the byte source', async () => {
    id = randomUUID();
    expect((await request('/content?path=secret')).status).toBe(404);
  });
  it('reuses a parsed subtitle window while authorizing each request and respecting revocation', async () => {
    content = Buffer.from(
      await readFile(
        new URL('../../web/tests/fixtures/motion-subtitles.mkv.base64', import.meta.url),
        'utf8',
      ),
      'base64',
    );
    const response = await request('/subtitles?path=fixture.mkv&track=3&time=2');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      start: 0,
      end: 22,
      cues: expect.arrayContaining([
        { id: expect.any(String), start: 1, end: 4, text: 'English first caption' },
      ]),
    });
    const parsedReads = reads;
    const again = await request('/subtitles?path=fixture.mkv&track=3&time=2.5');
    expect(again.status).toBe(200);
    expect(reads).toBe(parsedReads);
    expect(FileViewerService.prototype.open).toHaveBeenCalledTimes(2);
    actor = { ...fixture.context, actorUserId: randomUUID(), subjectUserId: randomUUID() };
    expect((await request('/subtitles?path=fixture.mkv&track=3&time=2')).status).toBe(403);
    expect(reads).toBe(parsedReads);
    actor = fixture.context;
    revoked.abort();
    expect((await request('/subtitles?path=fixture.mkv&track=3&time=2')).status).toBe(403);
    expect(reads).toBe(parsedReads);
  });
  it('rejects invalid subtitle windows before accessing bytes and unsupported tracks honestly', async () => {
    for (const query of [
      'track=3&time=NaN',
      'track=3&time=Infinity',
      'track=3&time=-1',
      'track=3&time=1e20',
      'track=bad&time=0',
    ])
      expect((await request(`/subtitles?path=fixture.mkv&${query}`)).status).toBe(400);
    expect(FileViewerService.prototype.open).not.toHaveBeenCalled();
    expect(reads).toBe(0);
    content = Buffer.from(
      await readFile(
        new URL('../../web/tests/fixtures/motion-subtitles.mkv.base64', import.meta.url),
        'utf8',
      ),
      'base64',
    );
    expect((await request('/subtitles?path=fixture.mkv&track=999&time=0')).status).toBe(422);
    expect((await request('/subtitles?path=fixture.mkv&track=7&time=0')).status).toBe(422);
  });
});
