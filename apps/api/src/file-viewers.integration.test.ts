import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  revoked = new AbortController();
  vi.spyOn(FileViewerService.prototype, 'open').mockImplementation(
    async (context, _runtime, serverId, path) => {
      await authorizeServer(db.db, context, serverId, 'server:read');
      return {
        source: {
          size: content.length,
          mtimeMs: 1,
          read: async (offset, length) => {
            reads++;
            return content.subarray(offset, offset + length);
          },
          stream: (start = 0, end = content.length) =>
            new ReadableStream({
              start(c) {
                c.enqueue(content.subarray(start, end));
                c.close();
              },
            }),
        },
        path,
        signal: revoked.signal,
        cache,
        key: `${id}:${path}`,
        close: async () => {},
        restat: async () => ({ size: content.length, mtimeMs: 1, mode: 0o644 }),
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
