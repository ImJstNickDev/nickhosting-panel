import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));

import { SafeContentHttp } from './http.js';

const paths: string[] = [];
beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.request.mockReset();
  mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
});
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function response(
  statusCode: number,
  body: Buffer,
  headers: Record<string, string> = {},
  afterResponse?: (stream: PassThrough) => void,
) {
  mocks.request.mockImplementationOnce((_url, options, callback) => {
    const req = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      destroy: vi.fn(),
      end: () => {
        const res = Object.assign(new PassThrough(), { statusCode, headers });
        queueMicrotask(() => {
          callback(res);
          afterResponse?.(res);
          res.end(body);
          req.emit('close');
        });
      },
    });
    options.lookup('cdn.modrinth.com', {}, (error: unknown, address: string, family: number) => {
      expect(error).toBe(null);
      expect(address).toBe('1.1.1.1');
      expect(family).toBe(4);
    });
    return req;
  });
}
function client(options: Partial<ConstructorParameters<typeof SafeContentHttp>[0]> = {}) {
  return new SafeContentHttp({
    allowedOrigins: ['https://cdn.modrinth.com'],
    userAgent: 'NickHosting-test',
    ...options,
  });
}
async function destination() {
  const root = await mkdtemp(join(tmpdir(), 'nh-http-'));
  paths.push(root);
  return join(root, 'download');
}
const body = Buffer.from('fixture content');
const artifact = {
  path: 'config/a.txt',
  urls: ['https://cdn.modrinth.com/a'],
  size: body.length,
  hashes: { sha512: createHash('sha512').update(body).digest('hex') },
  kind: 'override' as const,
  serverSide: 'required' as const,
};
it('pins validated DNS to the HTTPS socket and streams integrity-checked bytes', async () => {
  const path = await destination();
  response(200, body);
  expect(await client().download(artifact, path)).toEqual({
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
  });
  expect(await readFile(path)).toEqual(body);
  expect(mocks.request.mock.calls[0]?.[1]).toMatchObject({
    agent: false,
    headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'NickHosting-test' },
  });
});
it('refuses the whole DNS answer set when one address is private', async () => {
  mocks.lookup.mockResolvedValue([
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await expect(client().json('https://cdn.modrinth.com/a')).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
});
it('never follows metadata redirects or forwards a provider key to redirected origins', async () => {
  response(302, Buffer.from('redirect'), { location: 'https://evil.test/steal' });
  await expect(
    client().json('https://cdn.modrinth.com/a', { headers: { 'x-api-key': 'fixture-key' } }),
  ).rejects.toThrow();
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
const curseforgeOrigins = [
  'https://api.curseforge.com',
  'https://edge.forgecdn.net',
  'https://mediafilez.forgecdn.net',
];
const archivePath = '/files/2914/377/DIVERSITY%203%20PACKAGE%20v1.6.6.zip';
const edgeUrl = `https://edge.forgecdn.net${archivePath}`;
const downloadUrl = `https://mediafilez.forgecdn.net${archivePath}`;
const worldArtifact = {
  ...artifact,
  urls: [edgeUrl],
  hashes: { sha1: createHash('sha1').update(body).digest('hex') },
};
it('follows the CurseForge CDN redirect with independently pinned DNS and no metadata API key', async () => {
  const http = client({ allowedOrigins: curseforgeOrigins });
  response(200, Buffer.from('{"ok":true}'));
  await http.json('https://api.curseforge.com/v1/mods/1', {
    headers: { 'x-api-key': 'fixture-private-key' },
  });
  let redirected: PassThrough | undefined;
  response(302, Buffer.from('redirect'), { location: downloadUrl }, (stream) => {
    redirected = stream;
  });
  response(200, body);
  const path = await destination();
  expect(await http.download(worldArtifact, path)).toEqual({
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
  });
  expect(await readFile(path)).toEqual(body);
  expect(redirected?.destroyed).toBe(true);
  expect(mocks.lookup.mock.calls.map(([host]) => host)).toEqual([
    'api.curseforge.com',
    'edge.forgecdn.net',
    'mediafilez.forgecdn.net',
  ]);
  expect(mocks.request.mock.calls.map(([url]) => url.href)).toEqual([
    'https://api.curseforge.com/v1/mods/1',
    edgeUrl,
    downloadUrl,
  ]);
  for (const [, options] of mocks.request.mock.calls.slice(1))
    expect(options.headers).toEqual({
      'Accept-Encoding': 'identity',
      'User-Agent': 'NickHosting-test',
    });
});
it.each([301, 303, 307, 308])(
  'supports HTTP %s for approved archive download redirects',
  async (status) => {
    response(status, Buffer.from('redirect'), { location: downloadUrl });
    response(200, body);
    await expect(
      client({ allowedOrigins: curseforgeOrigins }).download(worldArtifact, await destination()),
    ).resolves.toMatchObject({ size: body.length });
  },
);
it('continues to reject metadata redirects even when both origins are approved', async () => {
  response(302, Buffer.from('redirect'), { location: downloadUrl });
  await expect(
    client({ allowedOrigins: curseforgeOrigins }).json('https://api.curseforge.com/v1/mods/1', {
      headers: { 'x-api-key': 'fixture-private-key' },
    }),
  ).rejects.toMatchObject({ code: 'integration_unavailable', status: 503 });
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
it.each([
  'https://evil.test/archive.zip',
  'http://mediafilez.forgecdn.net/archive.zip',
  'https://user:password@mediafilez.forgecdn.net/archive.zip',
  'https://127.0.0.1/archive.zip',
  `${downloadUrl}#fragment`,
])('rejects unapproved redirect location %s before opening another socket', async (location) => {
  response(302, Buffer.from('redirect'), { location });
  const path = await destination();
  await expect(
    client({ allowedOrigins: curseforgeOrigins }).download(worldArtifact, path),
  ).rejects.toMatchObject({ code: 'validation_failed', status: 400 });
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
  await expect(readFile(path)).rejects.toThrow();
});
it('rejects private or mixed DNS answers on a redirect before opening the target socket', async () => {
  mocks.lookup.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);
  mocks.lookup.mockResolvedValueOnce([
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  response(302, Buffer.from('redirect'), { location: downloadUrl });
  await expect(
    client({ allowedOrigins: curseforgeOrigins }).download(worldArtifact, await destination()),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(mocks.lookup).toHaveBeenCalledTimes(2);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
it('allows relative locations up to three redirects and rejects a fourth without retries', async () => {
  for (const location of ['/one', '/two', '/three']) response(302, Buffer.alloc(0), { location });
  response(200, body);
  await expect(
    client({ allowedOrigins: curseforgeOrigins }).download(worldArtifact, await destination()),
  ).resolves.toMatchObject({ size: body.length });
  expect(mocks.request).toHaveBeenCalledTimes(4);
  mocks.request.mockClear();
  for (const location of ['/one', '/two', '/three', '/four'])
    response(302, Buffer.alloc(0), { location });
  const path = await destination();
  await expect(
    client({ allowedOrigins: curseforgeOrigins }).download(worldArtifact, path),
  ).rejects.toMatchObject({ code: 'integration_unavailable', status: 503 });
  expect(mocks.request).toHaveBeenCalledTimes(4);
  await expect(readFile(path)).rejects.toThrow();
});
it('detects a redirect loop without issuing the repeated request', async () => {
  response(302, Buffer.alloc(0), { location: downloadUrl });
  response(302, Buffer.alloc(0), { location: edgeUrl });
  await expect(
    client({ allowedOrigins: curseforgeOrigins }).download(worldArtifact, await destination()),
  ).rejects.toMatchObject({ code: 'integration_unavailable', status: 503 });
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
it.each<{ status: number; headers: Record<string, string> }>([
  { status: 302, headers: {} },
  { status: 302, headers: { location: 'https://[' } },
  { status: 305, headers: { location: downloadUrl } },
  { status: 403, headers: {} },
  { status: 404, headers: {} },
])(
  'reports refused provider responses as unavailable, not internal errors: %j',
  async ({ status, headers }) => {
    response(status, Buffer.alloc(0), headers);
    await expect(
      client({ allowedOrigins: curseforgeOrigins }).download(worldArtifact, await destination()),
    ).rejects.toMatchObject({ code: 'integration_unavailable', status: 503 });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  },
);
it('honors cancellation between redirect hops without creating a partial destination', async () => {
  const controller = new AbortController();
  response(302, Buffer.alloc(0), { location: downloadUrl }, () => controller.abort());
  const path = await destination();
  await expect(
    client({ allowedOrigins: curseforgeOrigins }).download(worldArtifact, path, {
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(mocks.request).toHaveBeenCalledTimes(1);
  await expect(readFile(path)).rejects.toThrow();
});
it.each([Buffer.alloc(body.length + 1, 1), Buffer.alloc(body.length, 1)])(
  'retains size/hash verification and partial-file cleanup after redirects: %j',
  async (bytes) => {
    response(302, Buffer.alloc(0), { location: downloadUrl });
    response(200, bytes);
    const path = await destination();
    await expect(
      client({ allowedOrigins: curseforgeOrigins }).download(worldArtifact, path),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(readFile(path)).rejects.toThrow();
  },
);
it('bounds metadata and refuses compressed responses', async () => {
  response(200, Buffer.from('123456'));
  await expect(client({ maxJsonBytes: 5 }).json('https://cdn.modrinth.com/a')).rejects.toThrow();
  response(200, Buffer.from('zip'), { 'content-encoding': 'gzip' });
  await expect(client().json('https://cdn.modrinth.com/a')).rejects.toThrow();
});
it('cleans partial oversized downloads and rejects a same-size hash mismatch', async () => {
  const path = await destination();
  response(200, Buffer.from('more than the artifact size'));
  await expect(client().download(artifact, path)).rejects.toThrow();
  await expect(readFile(path)).rejects.toThrow();
  response(200, Buffer.alloc(body.length, 1));
  await expect(client().download(artifact, path)).rejects.toThrow();
  await expect(readFile(path)).rejects.toThrow();
});
it('retries temporary provider failures within a bounded budget', async () => {
  response(503, Buffer.from('retry'));
  response(200, Buffer.from('{"ok":true}'));
  expect(await client({ attempts: 2 }).json('https://cdn.modrinth.com/a')).toEqual({ ok: true });
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
it('does not retry a permanent missing file or hash failure', async () => {
  response(404, Buffer.from('missing'));
  await expect(client().json('https://cdn.modrinth.com/a')).rejects.toThrow();
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
it('validates all download alternatives before any connection and never overwrites existing destinations', async () => {
  const path = await destination();
  await expect(
    client().download({ ...artifact, urls: [...artifact.urls, 'https://evil.test/a'] }, path),
  ).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
  await writeFile(path, 'preserve');
  response(200, body);
  await expect(client().download(artifact, path)).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('preserve');
});
it('honors cancellation before network or disk side effects', async () => {
  const path = await destination();
  const controller = new AbortController();
  controller.abort();
  await expect(client().download(artifact, path, { signal: controller.signal })).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
  await expect(readFile(path)).rejects.toThrow();
});
