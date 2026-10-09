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
function response(statusCode: number, body: Buffer, headers: Record<string, string> = {}) {
  mocks.request.mockImplementationOnce((_url, options, callback) => {
    const req = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      destroy: vi.fn(),
      end: () => {
        const res = Object.assign(new PassThrough(), { statusCode, headers });
        queueMicrotask(() => {
          callback(res);
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
it('never follows redirects or forwards a provider key to redirected origins', async () => {
  response(302, Buffer.from('redirect'), { location: 'https://evil.test/steal' });
  await expect(
    client().json('https://cdn.modrinth.com/a', { headers: { 'x-api-key': 'fixture-key' } }),
  ).rejects.toThrow();
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
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
